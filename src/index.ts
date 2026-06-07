import { pathToFileURL } from "node:url";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { config, resolveCwd } from "./config.js";
import { ensureSession, getSession, commitSession, rollbackSession } from "./sessions.js";
import { runClaude } from "./claude.js";
import {
  stripMention,
  makeThreadTitle,
  sendChunked,
  keepTyping,
  resolveTopic,
  makeRemoteControlName,
  buildHistoryPreamble,
} from "./discord.js";

// ---------------------------------------------------------------------------
// Routing predicate (pure function, Discord-free — exported for unit testing)
// ---------------------------------------------------------------------------

export interface ShouldHandleArgs {
  /** message.author.bot */
  authorIsBot: boolean;
  /** message.inGuild() */
  inGuild: boolean;
  /** message.author.id */
  authorId: string;
  /** config.allowUserIds (empty = allow all) */
  allowUserIds: readonly string[];
  /** Bot がメンションされているか */
  isMentioned: boolean;
  /** sessions に登録済みのスレッドか */
  isKnownThread: boolean;
}

/**
 * このメッセージを処理すべきかを判定する純関数。
 *
 * 判定ルール（全部 AND）:
 * 1. Bot のメッセージは無視
 * 2. Guild 内のみ処理（DM は対象外）
 * 3. allowlist が空なら全員許可。非空なら authorId が含まれる場合のみ許可
 * 4. Bot へのメンション、または既知スレッド内のどちらかが必要（発火条件）
 */
export function shouldHandle(args: ShouldHandleArgs): boolean {
  const { authorIsBot, inGuild, authorId, allowUserIds, isMentioned, isKnownThread } = args;

  if (authorIsBot) return false;
  if (!inGuild) return false;

  // Access Control Policy: 空 = 全員許可、非空 = allowlist 照合
  if (allowUserIds.length > 0 && !allowUserIds.includes(authorId)) return false;

  // 発火条件: メンションまたは既知スレッド継続のどちらか
  if (!isMentioned && !isKnownThread) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Discord Client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 特権インテント（Developer Portal で要有効化）
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Ready: ${c.user.tag} (${c.user.id})`);
  console.log("  Guild 内でメンションするとスレッドを生成して応答します。");
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error("メッセージ処理エラー:", err);
  }
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(message: Message): Promise<void> {
  const botId = client.user?.id;
  const channel = message.channel;
  const inThread = channel.isThread();
  const isMentioned = botId ? message.mentions.users.has(botId) : false;

  // スレッド内かつ sessions に登録済みかを確認
  const knownEntry = inThread ? getSession(channel.id) : undefined;
  const isKnownThread = knownEntry !== undefined;

  if (
    !shouldHandle({
      authorIsBot: message.author.bot,
      inGuild: message.inGuild(),
      authorId: message.author.id,
      allowUserIds: config.allowUserIds,
      isMentioned,
      isKnownThread,
    })
  ) {
    return;
  }

  const userText = stripMention(message.content, botId);
  if (!userText) {
    await message.reply("はい、ご用件をどうぞ。").catch(() => {});
    return;
  }

  // 応答先スレッドを決定する（要件2）:
  //   チャンネルでメンション → 新規スレッドを生成
  //   スレッド内 → 同スレッドを継続
  let thread: ThreadChannel | undefined;
  let typing: { stop: () => void } | undefined;

  try {
    thread = inThread
      ? (channel as ThreadChannel)
      : await message.startThread({
          name: makeThreadTitle(userText),
          autoArchiveDuration: 1440,
        });

    await message.react("👀").catch(() => {});
    typing = keepTyping(thread);

    // 親チャンネル ID の解決
    const parentChannelId = inThread
      ? ((channel as ThreadChannel).parentId ?? channel.id)
      : channel.id;

    // remote-control 名を M4 の makeRemoteControlName で確定し、ensureSession に渡す
    const remoteControlName = makeRemoteControlName({ name: thread.name, id: thread.id });

    // セッション解決（要件4, 5, 8）
    const session = await ensureSession(
      thread.id,
      parentChannelId,
      resolveCwd(parentChannelId),
      remoteControlName
    );

    // topic 注入（要件6）
    const topic = resolveTopic(channel);

    // 既存スレッドだがセッション未登録のとき（再起動後・sessions.json 消失・人手作成
    // スレッドなど）、過去ログを文脈として prompt に前置する（要件3 / #9）。
    let prompt = userText;
    if (inThread && !isKnownThread) {
      const preamble = await buildHistoryPreamble(thread, message.id, botId);
      if (preamble) prompt = preamble + userText;
    }

    // claude 実行（要件7透過, 要件8 remote-control）
    const result = await runClaude({
      prompt,
      sessionId: session.sessionId,
      isNew: session.isNew,
      cwd: session.cwd,
      topic,
      remoteControlName: session.remoteControlName,
    });

    // セッションの確定/破棄（#5）: 新規セッションは初回が成功して初めて永続化し、
    // 失敗時は予約を破棄する。これで claude 側に無い UUID をディスクに残さず、
    // スレッドが恒久破損するのを防ぐ。
    if (session.isNew) {
      if (result.isError) {
        rollbackSession(thread.id);
      } else {
        commitSession(thread.id);
      }
    }

    await sendChunked(thread, result.text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (thread) {
      await thread.send(`（エラーが発生しました: ${detail.slice(0, 400)}）`).catch(() => {});
    } else {
      // スレッド生成失敗: 元メッセージへフォールバック
      await message.reply(`（スレッドの作成に失敗しました: ${detail.slice(0, 400)}）`).catch(() => {});
    }
  } finally {
    typing?.stop();
  }
}

// ---------------------------------------------------------------------------
// Entry guard — login runs only when this file is the entry point.
// Importing index.ts for unit tests does NOT trigger client.login().
// pathToFileURL を使うことで realpath/percent-encoding の差異（symlink・空白・# 等）
// による比較ミスマッチを避ける。手書きの new URL(argv[1], "file://") では起動経路が
// /tmp→/private/tmp のような symlink を含むと false になり Bot が黙って起動しなかった（#8）。
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  client.login(config.token).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Discord ログイン失敗: ${detail}`);
    console.error("  DISCORD_BOT_TOKEN を確認してください（Developer Portal → Bot → Reset Token）。");
    process.exit(1);
  });
}
