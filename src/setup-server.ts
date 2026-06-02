import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * 専用 Discord サーバーを Bot 権限で自動作成する。
 *
 *   1. ギルド（サーバー）を作成（Bot がオーナーになる）
 *   2. テキストチャンネル #jarvis を用意
 *   3. あなたが参加するための招待リンクを発行
 *   4. .env に JARVIS_GUILD_ID / JARVIS_CHANNEL_ID を書き込む
 *
 * Discord 制約: Bot 単独でのギルド作成は「参加ギルドが10未満」のときのみ可能。
 */

const API = "https://discord.com/api/v10";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("✗ DISCORD_BOT_TOKEN が未設定です。.env に設定してから再実行してください。");
  process.exit(1);
}

const guildName = process.argv[2] || process.env.JARVIS_GUILD_NAME || "Jarvis 秘書室";
const channelName = "jarvis";

async function dapi<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}\n${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** .env の1行を上書き／追記する。 */
function setEnvVar(key: string, value: string): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(envPath, content);
}

async function main(): Promise<void> {
  const me = await dapi<{ username: string; id: string }>("/users/@me", "GET");
  console.log(`Bot: ${me.username} (${me.id})`);

  console.log(`サーバー「${guildName}」を作成中…`);
  const guild = await dapi<{ id: string; name: string }>("/guilds", "POST", {
    name: guildName,
    channels: [{ name: channelName, type: 0 }], // 0 = GUILD_TEXT
  });

  const channels = await dapi<Array<{ id: string; type: number; name: string }>>(
    `/guilds/${guild.id}/channels`,
    "GET",
  );
  const textChannel = channels.find((c) => c.type === 0);
  if (!textChannel) throw new Error("テキストチャンネルの作成に失敗しました。");

  const invite = await dapi<{ code: string }>(`/channels/${textChannel.id}/invites`, "POST", {
    max_age: 0, // 無期限
    max_uses: 0, // 無制限
    unique: true,
  });

  setEnvVar("JARVIS_GUILD_ID", guild.id);
  setEnvVar("JARVIS_CHANNEL_ID", textChannel.id);

  console.log("\n✓ 専用サーバーを作成しました");
  console.log("──────────────────────────────────────────");
  console.log(`  サーバー   : ${guild.name} (${guild.id})`);
  console.log(`  チャンネル : #${textChannel.name} (${textChannel.id})`);
  console.log(`  .env に JARVIS_GUILD_ID / JARVIS_CHANNEL_ID を書き込みました`);
  console.log("──────────────────────────────────────────");
  console.log(`\n  👉 あなたの参加用 招待リンク:\n     https://discord.gg/${invite.code}\n`);
  console.log("  この後: 招待リンクから参加 → `./boot.sh` で起動 → #jarvis で @Jarvis にメンション\n");
}

main().catch((err) => {
  console.error("\n✗ セットアップ失敗:\n", err.message ?? err);
  console.error("\nヒント: Bot が既に10サーバー以上に参加していると自動作成できません。");
  console.error("その場合は手動でサーバーを作り、JARVIS_GUILD_ID / JARVIS_CHANNEL_ID を .env に設定してください。");
  process.exit(1);
});
