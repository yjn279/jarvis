import { spawn } from "node:child_process";
import { config } from "./config.js";

/** `runClaude` の戻り値。 */
export interface ClaudeResult {
  /** 応答テキスト（JSON の result フィールド）。エラー時はエラーメッセージ。 */
  text: string;
  /** このやり取りの session_id。次回の --resume に使う。 */
  sessionId: string;
  /** claude がエラーを返した、またはタイムアウト・パース失敗したとき true。 */
  isError: boolean;
}

/** `runClaude` のオプション。 */
export interface RunClaudeOptions {
  /** stdin へそのまま投入するプロンプト本文（/command を含む任意テキスト）。 */
  prompt: string;
  /** セッション UUID（isNew=true なら --session-id、false なら --resume に使う）。 */
  sessionId: string;
  /** true のとき --session-id（新規セッション）、false のとき --resume（継続）。 */
  isNew: boolean;
  /** claude を起動する作業ディレクトリの絶対パス。 */
  cwd: string;
  /**
   * チャンネル topic テキスト。空文字なら --append-system-prompt を付与しない。
   * 空でない場合、そのまま --append-system-prompt の値として渡す。
   */
  topic: string;
  /**
   * --remote-control に渡す名前。
   * config.remoteControlEnabled が false のとき、この値は無視される。
   */
  remoteControlName: string;
}

/**
 * 1応答あたりのタイムアウト上限（ミリ秒）。
 * claude の初回起動やモデルダウンロードを考慮して余裕を持たせる。
 *
 * 注: macOS には timeout コマンドが存在しないため、
 * ここでは setTimeout + SIGKILL によるプロセス時間制限を行う。
 */
const TIMEOUT_MS = 2 * 60 * 1000; // 120 秒

/**
 * `claude -p` をヘッドレス起動し、結果を返す。
 *
 * 引数組み立てのポリシー:
 * - 新規セッション: --session-id <uuid>、継続: --resume <uuid>
 * - topic が空でなければ --append-system-prompt <topic>
 * - config.remoteControlEnabled が true なら --remote-control <remoteControlName>
 * - config.permissionMode は常に付与
 * - config.model が設定されていれば --model <model>
 *
 * プロンプト本文は stdin へそのまま透過する（要件7）。
 * headless (-p) では claude 組み込みの /help 等が利用不可だが、
 * それ以外のスラッシュコマンド（例: /compact、プロジェクトスラッシュ等）は
 * stdin 透過で自然に流れる。制約が問題になる場合は
 * --input-format stream-json 常駐 PTY 方式への拡張を検討すること（Out of Scope）。
 *
 * @returns タイムアウト・パース失敗・claude エラーのいずれも isError=true として安全に返す。
 */
export function runClaude(opts: RunClaudeOptions): Promise<ClaudeResult> {
  const { prompt, sessionId, isNew, cwd, topic, remoteControlName } = opts;

  const args: string[] = [
    "-p",
    "--output-format", "json",
    "--permission-mode", config.permissionMode,
  ];

  // セッション継続 / 新規
  if (isNew) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--resume", sessionId);
  }

  // チャンネル topic をシステムプロンプトとして注入（要件6）
  if (topic !== "") {
    args.push("--append-system-prompt", topic);
  }

  // リモートコントロール（要件8）
  if (config.remoteControlEnabled) {
    args.push("--remote-control", remoteControlName);
  }

  // モデル指定（任意）
  if (config.model) {
    args.push("--model", config.model);
  }

  return new Promise<ClaudeResult>((resolve) => {
    let settled = false;

    const finish = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn("claude", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        text: "（応答がタイムアウトしました。もう一度試してください）",
        sessionId,
        isError: true,
      });
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err: Error) => {
      finish({
        text: `（claude の起動に失敗しました: ${err.message}）`,
        sessionId,
        isError: true,
      });
    });

    child.on("close", () => {
      try {
        const json = JSON.parse(stdout) as {
          type?: string;
          subtype?: string;
          result?: string;
          session_id?: string;
          is_error?: boolean;
        };
        finish({
          text: (json.result ?? "").trim(),
          sessionId: json.session_id ?? sessionId,
          isError: Boolean(json.is_error),
        });
      } catch {
        const detail = stderr.trim() || stdout.trim() || "（出力なし）";
        finish({
          text: `（応答の解析に失敗しました: ${detail.slice(0, 500)}）`,
          sessionId,
          isError: true,
        });
      }
    });

    // プロンプトを stdin へそのまま投入（/command を含む任意本文を透過）
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
