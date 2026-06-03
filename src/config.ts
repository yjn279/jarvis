import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { PERSONA } from "./persona.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ 環境変数 ${name} が未設定です。.env を確認してください（.env.example 参照）。`);
    process.exit(1);
  }
  return value;
}

const dataDir = process.env.JARVIS_DATA_DIR
  ? resolve(process.env.JARVIS_DATA_DIR)
  : join(root, "data");

/** アプリ全体の設定。env を一箇所で解決し、型付きで配る。 */
export const config = {
  /** Discord Bot トークン。 */
  token: required("DISCORD_BOT_TOKEN"),
  /** 反応する専用サーバー。未設定なら全サーバー。 */
  guildId: process.env.JARVIS_GUILD_ID || undefined,
  /** 反応するチャンネル。未設定ならサーバー内全チャンネル。 */
  channelId: process.env.JARVIS_CHANNEL_ID || undefined,
  /**
   * 秘書を操作できるユーザーの Discord ID（許可リスト）。
   * 秘書はオーナーの Claude 権限で動くため、ここに無いユーザーの指示は無視する。
   * 空配列なら専用サーバー内の全員を許可（後方互換）。
   */
  allowedUserIds: (process.env.JARVIS_ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** claude のパーミッションモード。 */
  permissionMode: process.env.CLAUDE_PERMISSION_MODE || "default",
  /** claude が動く作業ディレクトリ。 */
  workdir: process.env.JARVIS_WORKDIR
    ? resolve(process.env.JARVIS_WORKDIR)
    : join(root, "workspace"),
  /** 使う Claude モデル（任意）。 */
  model: process.env.CLAUDE_MODEL || undefined,
  /** 秘書の人格（システムプロンプトに追記）。 */
  persona: PERSONA,
  /** スレッド↔セッション対応表の保存先。 */
  sessionsFile: join(dataDir, "sessions.json"),
} as const;
