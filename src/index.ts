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
import { ensureSession, getSession, commitSession, rollbackSession, closeSession } from "./sessions.js";
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
import { makePermissionBridge } from "./interactive.js";

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

// 同一メッセージの並行処理を防ぐ。Gateway の二重配信や再接続リプレイで同じ
// メッセージ ID に対して MessageCreate が複数届いた場合、2 本目以降は無視する。
// Set への has/add はマイクロタスクをはさまず同期的なので競合しない。
const processingMessages = new Set<string>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 特権インテント（Developer Portal で要有効化）
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Ready: ${c.user.tag} (${c.user.id})`);
  console.log("  Guild 内でメンションするとスレッドを生成して応答します。");
});

client.on(Events.MessageCreate, async (message) => {
  if (processingMessages.has(message.id)) return;
  processingMessages.add(message.id);
  try {
    await handleMessage(message);
  } catch (err) {
    console.error("メッセージ処理エラー:", err);
  } finally {
    processingMessages.delete(message.id);
  }
});

// スレッドのクローズ/アーカイブ/削除でセッションを閉じる（#4）。
// 閉じた後は getSession が undefined を返すため isKnownThread=false となり、
// 以後はメンションが無い限り応答しない。アーカイブ解除（新規メッセージ投稿）時は
// 「新規スレッド」扱いとなり、要件3 の履歴プリアンブル（#9）で文脈を引き継ぐ。
client.on(Events.ThreadDelete, (thread) => {
  if (closeSession(thread.id)) {
    console.log(`スレッド削除に伴いセッションを閉じました: ${thread.id}`);
  }
});

client.on(Events.ThreadUpdate, (oldThread, newThread) => {
  // アーカイブされた瞬間（false → true）のみ反応する。リネーム等の他更新は無視。
  if (!oldThread.archived && newThread.archived) {
    if (closeSession(newThread.id)) {
      console.log(`スレッドのアーカイブに伴いセッションを閉じました: ${newThread.id}`);
    }
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
  const isKnownThread = inThread ? getSession(channel.id) !== undefined : false;

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

  try {
    if (inThread) {
      thread = channel as ThreadChannel;
    } else {
      try {
        thread = await message.startThread({
          name: makeThreadTitle(userText),
          autoArchiveDuration: 1440,
        });
      } catch (startErr) {
        // Discord エラー 160004: このメッセージには既にスレッドが存在する。
        // 二重起動・競合・UI 先行作成などで発生するため、既存スレッドへフォールバック。
        if (!(startErr instanceof Error && startErr.message.includes("thread has already been created"))) {
          throw startErr;
        }
        thread =
          (message.thread as ThreadChannel | null) ??
          (message.guild?.channels.cache.get(message.id) as ThreadChannel | undefined);
        if (!thread) throw startErr;
      }

      // チャンネルからスレッドを新規または既存で取得した場合、ユーザーをメンバーに追加する。
      // これをしないとユーザーの Discord クライアントがスレッドを購読せず、
      // typing・新着返信が gateway でライブ配信されない。
      await thread.members.add(message.author.id).catch(() => {});
    }

    await message.react("👀").catch(() => {});

    const parentChannelId = inThread
      ? ((channel as ThreadChannel).parentId ?? channel.id)
      : channel.id;

    // 既存スレッドだがセッション未登録のときのみ過去ログを文脈に前置する（要件3 / #9）
    await respondInThread(thread, parentChannelId, userText, {
      historyBeforeId: inThread && !isKnownThread ? message.id : undefined,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (thread) {
      await thread.send(`（エラーが発生しました: ${detail.slice(0, 400)}）`).catch(() => {});
    } else {
      // スレッド生成失敗: 元メッセージへフォールバック
      await message.reply(`（スレッドの作成に失敗しました: ${detail.slice(0, 400)}）`).catch(() => {});
    }
  }
}

/**
 * スレッド内で claude を起動し、応答を分割送信する共通処理。
 * メンション起動・スレッド継続（handleMessage）から使う。
 *
 * セッション解決（要件4,5,8）・topic 注入（要件6）・履歴前置（要件3 / #9）・
 * 確定/破棄（#5）をここに集約する。typing 表示はこの関数の責務とする。
 */
async function respondInThread(
  thread: ThreadChannel,
  parentChannelId: string,
  userText: string,
  opts: { historyBeforeId?: string } = {}
): Promise<void> {
  const typing = keepTyping(thread);
  try {
    // remote-control 名を makeRemoteControlName で確定し、ensureSession に渡す
    const remoteControlName = makeRemoteControlName({ name: thread.name, id: thread.id });
    const session = await ensureSession(
      thread.id,
      parentChannelId,
      resolveCwd(parentChannelId),
      remoteControlName
    );

    // topic 注入（要件6）。スレッドからは親チャンネルの topic を辿る。
    const topic = resolveTopic(thread);

    let prompt = userText;
    if (opts.historyBeforeId) {
      // 履歴は allowlist 該当者＋Bot の発言のみに限定（cross-principal インジェクション防止）
      const preamble = await buildHistoryPreamble(
        thread,
        opts.historyBeforeId,
        config.allowUserIds,
        client.user?.id
      );
      if (preamble) prompt = preamble + userText;
    }

    // 対話的な許可・質問・プラン承認を Discord UI へ橋渡しするブリッジ（#2）。
    // 操作可能なユーザーは shouldHandle と同じ allowlist 方針に揃える。
    const canUseTool = makePermissionBridge({
      thread,
      allowUserIds: config.allowUserIds,
      timeoutMs: config.interactionTimeoutMs,
    });

    // claude 実行。userText は stripMention 済みで先頭の `/command` も保持されるため、
    // SDK の query() がそれを slash command として解釈・実行する（要件7: 透過）。
    // permissionMode は config 既定（既定 default）に委ね、対話 UI #2 を発火させる。
    const result = await runClaude({
      prompt,
      sessionId: session.sessionId,
      isNew: session.isNew,
      cwd: session.cwd,
      topic,
      remoteControlName: session.remoteControlName,
      canUseTool,
    });

    // 新規セッションは初回成功で確定、失敗で破棄（#5）
    if (session.isNew) {
      if (result.isError) rollbackSession(thread.id);
      else commitSession(thread.id);
    }

    await sendChunked(thread, result.text);
  } finally {
    typing.stop();
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
