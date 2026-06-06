import type {
  ThreadChannel,
  TextChannel,
  NewsChannel,
  AnyThreadChannel,
  Channel,
} from "discord.js";

const DISCORD_MAX = 2000; // Discord の1メッセージ上限

// ---------------------------------------------------------------------------
// Text utilities (ported from jarvis 79007ed:src/discord.ts)
// ---------------------------------------------------------------------------

/** 本文から自分宛てメンション (<@id> / <@!id>) を取り除く。 */
export function stripMention(content: string, botId?: string): string {
  if (!botId) {
    // botId 未指定時はすべての <@...> メンションを除去する
    return content.replace(/<@!?\d+>/g, "").trim();
  }
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

/**
 * スレッドのタイトルを本文の先頭から作る（最大80文字・1行）。
 * Discord の <@id>/<#id>/<@&id> 等のメンション記法も除去してから使う。
 */
export function makeThreadTitle(text: string): string {
  // Discord のメンション記法を除去
  const cleaned = text
    .replace(/<@!?\d+>/g, "")   // ユーザーメンション
    .replace(/<#\d+>/g, "")     // チャンネルメンション
    .replace(/<@&\d+>/g, "");   // ロールメンション

  const oneLine = cleaned.replace(/\s+/g, " ").trim();
  if (!oneLine) return "会話";
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
}

/**
 * テキストを Discord の上限（limit 文字）以下のチャンクに分割する。
 * 改行・空白を優先的な区切りとし、コードブロックや段落をなるべく壊さない。
 */
export function splitText(text: string, limit: number = DISCORD_MAX): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    // 改行 → 空白 の順に、上限内で一番後ろの区切りを探す
    let cut = slice.lastIndexOf("\n");
    if (cut < limit * 0.5) cut = slice.lastIndexOf(" ");
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 応答を 2000 文字ごとに分割して順番に送る。 */
export async function sendChunked(thread: ThreadChannel, text: string): Promise<void> {
  const body = text.length > 0 ? text : "（応答がありませんでした）";
  for (const chunk of splitText(body, DISCORD_MAX)) {
    await thread.send(chunk);
  }
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
      const who = m.author.id === botId ? "Bot" : m.author.username;
      const text = stripMention(m.content, botId);
      return text ? `${who}: ${text}` : "";
    })
    .filter(Boolean);

  if (lines.length === 0) return "";
  return `これまでの会話履歴:\n${lines.join("\n")}\n---\n上記の文脈を踏まえて、次の発言に応答してください。\n\n`;
}

// ---------------------------------------------------------------------------
// Topic resolution (M4 addition)
// ---------------------------------------------------------------------------

/**
 * チャンネルの topic を返す。スレッドの場合は親チャンネル（`channel.parent`）を辿る。
 * topic が無ければ空文字を返す。discord.js v14 の型でナローイングし安全に参照する。
 */
export function resolveTopic(channel: Channel): string {
  // スレッドチャンネルの場合は親を辿る
  if (isThread(channel)) {
    const parent = channel.parent;
    if (parent && "topic" in parent && typeof parent.topic === "string") {
      return parent.topic;
    }
    return "";
  }

  // テキストチャンネル / ニュースチャンネルは直接 topic を持つ
  if ("topic" in channel && typeof (channel as TextChannel | NewsChannel).topic === "string") {
    return (channel as TextChannel | NewsChannel).topic as string;
  }

  return "";
}

/** discord.js v14 でスレッド系チャンネルかを判定するナローイング関数。 */
function isThread(channel: Channel): channel is AnyThreadChannel {
  return "parent" in channel && "parentId" in channel;
}

// ---------------------------------------------------------------------------
// Remote-control naming (M4 addition)
// ---------------------------------------------------------------------------

/**
 * Discord の --remote-control に渡す安定名を生成する。
 *
 * 命名規則: `dcc-<slug>-<shortId>`
 * - slug: スレッド名を小文字化・ASCII 以外を除去・空白/記号をハイフンに置換（最大20文字）
 * - shortId: スレッド ID の末尾8文字（M2 の仮実装 `dcc-${threadId.slice(-8)}` と接頭辞を揃える）
 *
 * 引数を最小プロパティ `{ name: string; id: string }` に絞り純関数として提供する。
 */
export function makeRemoteControlName(thread: { name: string; id: string }): string {
  const slug = thread.name
    .toLowerCase()
    // ASCII 英数字・ハイフン以外をハイフンに置換
    .replace(/[^a-z0-9-]/g, "-")
    // 連続するハイフンを1つに
    .replace(/-+/g, "-")
    // 先頭・末尾のハイフンを除去
    .replace(/^-+|-+$/g, "")
    // 最大20文字に切り詰め
    .slice(0, 20)
    // 切り詰め後の末尾ハイフンを除去
    .replace(/-+$/, "");

  const shortId = thread.id.slice(-8);

  // slug が空（絵文字のみのスレッド名など）の場合は shortId のみ
  const name = slug ? `dcc-${slug}-${shortId}` : `dcc-${shortId}`;

  // Discord の remote-control 名として使える文字のみ（英数字・ハイフン・アンダースコア）
  // すでに上記で整形済みだが念のため最終チェック
  return name.replace(/[^a-z0-9-_]/g, "-");
}
