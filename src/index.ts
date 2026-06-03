import { Client, Events, GatewayIntentBits, Partials, ThreadChannel, type Message } from "discord.js";
import { config } from "./config.js";
import { askClaude } from "./claude.js";
import { getSession, setSession } from "./sessions.js";
import { stripMention, makeThreadTitle, sendChunked, keepTyping, buildHistoryPreamble } from "./discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 特権インテント（Developer Portal で要有効化）
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, (c) => {
  console.log(`🤵 Jarvis 起動: ${c.user.tag} (${c.user.id})`);
  console.log("   参加中のサーバーで @メンションすると応答します。");
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(message);
  } catch (err) {
    console.error("メッセージ処理エラー:", err);
  }
});

/**
 * 会話のルーティング。
 *
 * - チャンネルで @メンション → そのメッセージから新しいスレッドを作り、新規セッションで応答。
 * - 秘書が管理するスレッド内 → メンション不要で会話を継続（既存セッションを --resume）。
 * - メンションも既存スレッドも無し → 無視。
 *
 * こうして「Discord スレッド ↔ Claude セッション」が 1 対 1 で対応し、履歴が引き継がれる。
 */
async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return; // 自分や他Botは無視
  if (!message.inGuild()) return; // Guild 内のみ（DM は扱わない）

  const botId = client.user?.id;
  const channel = message.channel;
  const inThread = channel.isThread();
  const mentioned = botId ? message.mentions.users.has(botId) : false;
  const known = inThread ? getSession(channel.id) : undefined;

  // 既存スレッドの継続、または @メンションに反応する
  if (!known && !mentioned) return;

  const userText = stripMention(message.content, botId);
  if (!userText) {
    await message.reply("はい、ご用件をどうぞ。").catch(() => {});
    return;
  }

  // 応答先スレッドを決める：スレッド内ならそのまま、チャンネルなら新規スレッドを作る
  const thread: ThreadChannel = inThread
    ? (channel as ThreadChannel)
    : await message.startThread({ name: makeThreadTitle(userText), autoArchiveDuration: 1440 });

  await message.react("👀").catch(() => {});
  const typing = keepTyping(thread);

  try {
    const entry = getSession(thread.id);
    let prompt = userText;
    if (!entry && inThread) {
      // セッション未登録のスレッドを引き継ぐ場合だけ、過去ログを文脈として渡す
      prompt = (await buildHistoryPreamble(thread, message.id, botId)) + userText;
    }

    const result = await askClaude({ prompt, resumeSessionId: entry?.sessionId });

    if (result.sessionId) {
      setSession(thread.id, result.sessionId, inThread ? (channel.parentId ?? channel.id) : channel.id);
    }
    await sendChunked(thread, result.text);
  } finally {
    typing.stop();
  }
}

client.login(config.token).catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`✗ Discord ログイン失敗: ${detail}`);
  console.error("  DISCORD_BOT_TOKEN を確認してください（Developer Portal → Bot → Reset Token）。");
  process.exit(1);
});
