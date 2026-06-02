import { ThreadChannel } from "discord.js";

const DISCORD_MAX = 2000; // Discord の1メッセージ上限

/** 本文から自分宛てメンション(<@id> / <@!id>)を取り除く。 */
export function stripMention(content: string, botId?: string): string {
  if (!botId) return content.trim();
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/** スレッドのタイトルを本文の先頭から作る（最大80文字・1行）。 */
export function makeThreadTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return "会話";
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/** 応答を 2000 文字ごとに分割して順番に送る（コードブロックや段落をなるべく壊さない）。 */
export async function sendChunked(thread: ThreadChannel, text: string): Promise<void> {
  const body = text.length > 0 ? text : "（応答がありませんでした）";
  for (const chunk of splitText(body, DISCORD_MAX)) {
    await thread.send(chunk);
  }
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // 改行 → 空白 の順に、上限内で一番後ろの区切りを探す
    const slice = rest.slice(0, limit);
    let cut = slice.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = slice.lastIndexOf(" ");
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 応答を作っている間「入力中…」を出し続ける。返り値の stop() で止める。 */
export function keepTyping(thread: ThreadChannel): { stop: () => void } {
  const tick = () => thread.sendTyping().catch(() => {});
  tick();
  const timer = setInterval(tick, 8000); // Discord の typing は約10秒で消える
  return { stop: () => clearInterval(timer) };
}

/**
 * セッション未登録のスレッドを引き継ぐとき、過去ログを文脈として組み立てる。
 * （通常は秘書が作った新規スレッドなので空。Bot 再起動後やログ消失時の保険。）
 */
export async function buildHistoryPreamble(
  thread: ThreadChannel,
  beforeMessageId: string,
  botId?: string,
): Promise<string> {
  const fetched = await thread.messages.fetch({ limit: 50, before: beforeMessageId }).catch(() => null);
  if (!fetched || fetched.size === 0) return "";

  const lines = [...fetched.values()]
    .reverse() // 古い順
    .map((m) => {
      const who = m.author.id === botId ? "Jarvis" : m.author.username;
      const text = stripMention(m.content, botId);
      return text ? `${who}: ${text}` : "";
    })
    .filter(Boolean);

  if (lines.length === 0) return "";
  return `これまでの会話履歴:\n${lines.join("\n")}\n---\n上記の文脈を踏まえて、次の発言に応答してください。\n\n`;
}
