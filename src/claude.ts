import { query, type CanUseTool, type Options, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

/** `runClaude` の戻り値。 */
export interface ClaudeResult {
  /** 応答テキスト（result メッセージの本文）。エラー時はエラーメッセージ。 */
  text: string;
  /** このやり取りの session_id。次回の resume に使う。 */
  sessionId: string;
  /** claude がエラーを返した、またはタイムアウト・実行失敗したとき true。 */
  isError: boolean;
}

/** `runClaude` のオプション。 */
export interface RunClaudeOptions {
  /** Claude へ渡すプロンプト本文（/command を含む任意テキスト）。 */
  prompt: string;
  /** セッション UUID（isNew=true なら sessionId、false なら resume に使う）。 */
  sessionId: string;
  /** true のとき新規セッション（sessionId 指定）、false のとき継続（resume）。 */
  isNew: boolean;
  /** claude を起動する作業ディレクトリの絶対パス。 */
  cwd: string;
  /**
   * チャンネル topic テキスト。空文字なら system prompt へ追記しない。
   * 空でなければ claude_code プリセットの `append` として渡す。
   */
  topic: string;
  /** セッションを識別する安定名（Claude アプリのセッション一覧に表示するタイトル）。 */
  remoteControlName: string;
  /**
   * 対話的な許可・質問・プラン承認を Discord UI へ橋渡しするコールバック（#2）。
   * 未指定のときは SDK 既定（プロンプト不可＝自動拒否）になる。
   */
  canUseTool?: CanUseTool;
  /**
   * このターンのパーミッションモード上書き（例: `"plan"`）。
   * 未指定なら config.permissionMode を使う。
   */
  permissionMode?: PermissionMode;
}

/**
 * `@anthropic-ai/claude-agent-sdk` の `query()` で claude を1ターン実行し、結果を返す。
 *
 * 旧実装（`claude -p` の spawn + 生 stream-json）は許可を自動拒否し対話 UI を描画できなかった。
 * 本実装は SDK の `canUseTool` を経由して許可・AskUserQuestion・ExitPlanMode を Discord の
 * ネイティブ UI（ボタン／セレクト）へ橋渡しする（#2）。認証は端末にログイン済みの `claude`
 * 資格情報をそのまま利用する（ANTHROPIC_API_KEY は不要）。
 *
 * 引数組み立てのポリシー:
 * - 新規セッション: `sessionId` で UUID を固定、継続: `resume`
 * - topic が空でなければ claude_code プリセットへ `append`
 * - config.model が設定されていれば `model`
 * - パーミッションモードは permissionMode 上書き → config.permissionMode の順
 * - 新規かつ remoteControlEnabled のときセッション `title` に安定名を付与（Claude アプリで識別可能）
 *
 * タイムアウトは AbortController で query 全体を中断する。許可待ち時間も含むため、
 * 対話的な確認を挟む場合は CLAUDE_TIMEOUT_MS を十分長く取る（既定30分）。
 *
 * @returns タイムアウト・実行失敗・claude エラーのいずれも isError=true として安全に返す。
 */
export async function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const { prompt, sessionId, isNew, cwd, topic, remoteControlName, canUseTool, permissionMode } = opts;

  const controller = new AbortController();
  const timeoutMs = config.claudeTimeoutMs; // 0 で無効
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const options: Options = {
    cwd,
    abortController: controller,
    permissionMode: permissionMode ?? (config.permissionMode as PermissionMode),
    canUseTool,
  };
  if (isNew) options.sessionId = sessionId;
  else options.resume = sessionId;
  if (topic !== "") options.systemPrompt = { type: "preset", preset: "claude_code", append: topic };
  if (config.model) options.model = config.model;
  // 旧 --remote-control（対話セッション専用フラグ）は headless query と非互換のため使わない。
  // 代わりに新規セッションのタイトルへ安定名を付け、Claude アプリの履歴で識別可能にする（要件8 を代替）。
  if (config.remoteControlEnabled && isNew) options.title = remoteControlName;

  const timeoutText = (): string => {
    const mins = Math.round(timeoutMs / 60000);
    return `（応答が約 ${mins} 分のタイムアウトに達したため中断しました。長時間の作業が必要な場合は CLAUDE_TIMEOUT_MS を延長してください）`;
  };

  let text = "";
  let resolvedSessionId = sessionId;
  let isError = false;

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        resolvedSessionId = message.session_id;
      } else if (message.type === "result") {
        resolvedSessionId = message.session_id;
        if (message.subtype === "success") {
          text = message.result.trim();
          isError = message.is_error;
        } else {
          isError = true;
          const detail = message.errors.length > 0 ? `: ${message.errors.join("; ").slice(0, 400)}` : "";
          text = `（実行エラー [${message.subtype}]${detail}）`;
        }
      }
    }
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (timedOut) return { text: timeoutText(), sessionId: resolvedSessionId, isError: true };
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[claude] query failed: ${detail.slice(0, 500)}`);
    return { text: `（claude の実行に失敗しました: ${detail.slice(0, 400)}）`, sessionId: resolvedSessionId, isError: true };
  }

  if (timer) clearTimeout(timer);
  if (timedOut) return { text: timeoutText(), sessionId: resolvedSessionId, isError: true };
  return { text, sessionId: resolvedSessionId, isError };
}
