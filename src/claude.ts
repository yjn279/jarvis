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
 * タイムアウト到達後、SIGTERM で猶予を与えてから SIGKILL するまでの待機（ミリ秒）。
 * claude に後始末（書き込み中ファイルの整合・子プロセスの停止）の機会を残す。
 */
const KILL_GRACE_MS = 10 * 1000; // 10 秒

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

  const timeoutMs = config.claudeTimeoutMs; // 0 で無効

  return new Promise<ClaudeResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const clearTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
    };

    const finish = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    // detached:true で子は新しいプロセスグループのリーダーになる。
    // これにより、claude が起動した孫プロセス（npm・dev server・git 等）まで
    // -pid（プロセスグループ宛て）でまとめてシグナルを送れる（孤児化を防ぐ）。
    const child = spawn("claude", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    /** 子プロセスグループ全体へシグナルを送る。グループ送信に失敗したら単体へフォールバック。 */
    const signalTree = (signal: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal); // 負の pid = プロセスグループ全体
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* 既に終了している */
        }
      }
    };

    let stdout = "";
    let stderr = "";

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL は捕捉不能でクリーンアップが走らないため、まず SIGTERM で猶予を与える。
        signalTree("SIGTERM");
        // 猶予後も終了しなければ SIGKILL で確実に停止する。
        graceTimer = setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err: Error) => {
      finish({
        text: `（claude の起動に失敗しました: ${err.message}）`,
        sessionId,
        isError: true,
      });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        const mins = Math.round(timeoutMs / 60000);
        finish({
          text: `（応答が約 ${mins} 分のタイムアウトに達したため中断しました。長時間の作業が必要な場合は CLAUDE_TIMEOUT_MS を延長してください）`,
          sessionId,
          isError: true,
        });
        return;
      }
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
        const exitInfo = signal ? `signal=${signal}` : `exit=${code ?? "null"}`;
        console.error(`[claude] JSON parse failed (${exitInfo}): ${detail.slice(0, 500)}`);
        finish({
          text: `（応答の解析に失敗しました [${exitInfo}]: ${detail.slice(0, 500)}）`,
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
