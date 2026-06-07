import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import os from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * パス先頭の `~` / `~/` を実行ユーザーのホームディレクトリへ展開する。
 * `~` はシェルの機能で Node は展開しないため、spawn の cwd に渡す前にここで処理する（#6）。
 */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 設定値のパスを `~` 展開のうえ絶対パスへ解決する。
 * 相対パスはプロセスの cwd 基準で resolve される。
 */
function toAbsolutePath(p: string): string {
  return resolve(expandHome(p));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `✗ 環境変数 ${name} が未設定です。.env を確認してください（.env.example 参照）。`
    );
    process.exit(1);
  }
  return value;
}

/** チャンネル ID → 絶対パス のマップを env からパース。不正 JSON は即終了。 */
function parseChannelCwdMap(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "" || raw.trim() === "{}") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("CHANNEL_CWD_MAP must be a JSON object");
    }
    // 値をすべて文字列として保証し、`~`/相対パスを絶対パスへ解決する（#6）
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
        if (typeof v !== "string") {
          throw new TypeError(`CHANNEL_CWD_MAP value for key "${k}" must be a string`);
        }
        return [k, toAbsolutePath(v)];
      })
    );
  } catch (err) {
    console.error(
      `✗ CHANNEL_CWD_MAP のパースに失敗しました: ${(err as Error).message}`
    );
    process.exit(1);
  }
}

/** オーナー allowlist を env からパース。空文字列なら空配列（全員許可）。 */
function parseAllowlist(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

const dataDir = process.env.DATA_DIR
  ? toAbsolutePath(process.env.DATA_DIR)
  : join(root, "data");

const channelCwdMap = parseChannelCwdMap(process.env.CHANNEL_CWD_MAP);

const defaultWorkdir = process.env.DEFAULT_WORKDIR
  ? toAbsolutePath(process.env.DEFAULT_WORKDIR)
  : os.homedir();

/** アプリ全体の設定。env を一箇所で解決し、型付きで配る。 */
export const config = {
  /** Discord Bot トークン（必須）。 */
  token: required("DISCORD_BOT_TOKEN"),

  /**
   * 応答を許可する Discord ユーザー ID のリスト。
   * 空配列のときは全員許可（Access Control Policy 参照）。
   */
  allowUserIds: parseAllowlist(process.env.DISCORD_ALLOW_USER_IDS),

  /**
   * チャンネル ID → 絶対 cwd パス のマップ。
   * 存在しないチャンネル ID は defaultWorkdir にフォールバックする。
   */
  channelCwdMap,

  /** allowlist に載っていないチャンネルの既定 cwd。 */
  defaultWorkdir,

  /** claude のパーミッションモード。 */
  permissionMode: process.env.CLAUDE_PERMISSION_MODE || "default",

  /**
   * `--remote-control` を有効にするか。
   * env が "true"（大文字小文字問わず）のとき有効。既定 true。
   */
  remoteControlEnabled:
    (process.env.REMOTE_CONTROL_ENABLED ?? "true").toLowerCase() !== "false",

  /** 使う Claude モデル（任意。未設定なら claude 既定）。 */
  model: process.env.CLAUDE_MODEL || undefined,

  /** スレッド↔セッション対応表の保存先。 */
  sessionsFile: join(dataDir, "sessions.json"),
} as const;

/**
 * チャンネル ID から cwd を解決する純関数。
 * マップに存在すればその絶対パスを、なければ defaultWorkdir を返す。
 * channelCwdMap / defaultWorkdir はいずれも読み込み時に `~` 展開・絶対パス化済みのため、
 * 戻り値は常に絶対パス。パスの実在検証はランナー側の責務とする。
 */
export function resolveCwd(channelId: string): string {
  return config.channelCwdMap[channelId] ?? config.defaultWorkdir;
}
