import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";

/** claude ヘッドレス実行の結果。 */
export interface ClaudeResult {
  /** 応答テキスト（result フィールド）。 */
  text: string;
  /** このやり取りのセッションID。次回の --resume に使う。 */
  sessionId: string;
  isError: boolean;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 1応答あたりの上限

/**
 * `claude -p` をヘッドレス実行する。これが秘書の頭脳。
 *
 * - resumeSessionId 未指定: 新規セッションを開始し、生成された session_id を返す。
 * - resumeSessionId 指定: そのセッションを継続する（過去の文脈を保持）。
 *
 * プロンプトは stdin 経由で渡し、任意の本文を安全に扱う。
 */
export function askClaude(opts: {
  prompt: string;
  resumeSessionId?: string;
}): Promise<ClaudeResult> {
  const args = ["-p", "--output-format", "json", "--permission-mode", config.permissionMode];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (config.model) args.push("--model", config.model);
  if (config.persona) args.push("--append-system-prompt", config.persona);

  mkdirSync(config.workdir, { recursive: true });

  return new Promise<ClaudeResult>((resolve) => {
    const fallbackSid = opts.resumeSessionId ?? "";
    const child = spawn("claude", args, {
      cwd: config.workdir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ClaudeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ text: "（応答がタイムアウトしました。もう一度試してください）", sessionId: fallbackSid, isError: true });
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      finish({ text: `（claude の起動に失敗しました: ${err.message}）`, sessionId: fallbackSid, isError: true });
    });

    child.on("close", (code) => {
      try {
        const json = JSON.parse(stdout) as { result?: string; session_id?: string; is_error?: boolean };
        finish({
          text: (json.result ?? "").trim(),
          sessionId: json.session_id || fallbackSid,
          isError: Boolean(json.is_error),
        });
      } catch {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        finish({ text: `（応答の解析に失敗しました: ${detail.slice(0, 500)}）`, sessionId: fallbackSid, isError: true });
      }
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
