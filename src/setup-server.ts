import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * 秘書を専用サーバーに接続する準備をする。
 *
 * Discord は Bot 単独でのサーバー作成（POST /guilds）を禁止しているため、
 * サーバー作成と Bot 追加はユーザーのアカウントで行う。本スクリプトは:
 *
 *   1. トークンを検証し、Bot がどのサーバーに参加しているかを調べる
 *   2. 参加済みなら、その専用サーバーとテキストチャンネルを .env に記録する
 *   3. 未参加なら、Bot をサーバーへ追加する OAuth 招待 URL を案内する
 *
 * 一度サーバーへ追加すれば、以降はこのコマンドが自動で ID を解決する。
 */

const API = "https://discord.com/api/v10";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

// View Channels | Send Messages | Create Public Threads | Send Messages in Threads
// | Read Message History | Add Reactions
const INVITE_PERMISSIONS = "309237713984";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("✗ DISCORD_BOT_TOKEN が未設定です。.env に設定してから再実行してください。");
  process.exit(1);
}

async function dapi<T>(path: string, method = "GET"): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function setEnvVar(key: string, value: string): void {
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(envPath, content);
}

interface Guild { id: string; name: string; }
interface Channel { id: string; type: number; name: string; position: number; }

async function main(): Promise<void> {
  const me = await dapi<{ username: string; id: string }>("/users/@me");
  console.log(`Bot: ${me.username} (${me.id})`);

  const inviteUrl =
    `https://discord.com/oauth2/authorize?client_id=${me.id}` +
    `&permissions=${INVITE_PERMISSIONS}&scope=bot`;

  const guilds = await dapi<Guild[]>("/users/@me/guilds");

  if (guilds.length === 0) {
    console.log("\nまだどのサーバーにも参加していません。");
    console.log("次の URL を開き、専用サーバーを選んで Bot を追加してください:\n");
    console.log(`  ${inviteUrl}\n`);
    console.log("追加後にもう一度 `npm run setup` を実行すると、サーバーを自動検出します。");
    return;
  }

  // 専用サーバーを選ぶ: JARVIS_GUILD_ID 指定があればそれ、無ければ最初の1つ。
  const preferred = process.env.JARVIS_GUILD_ID;
  const guild = guilds.find((g) => g.id === preferred) ?? guilds[0]!;

  const channels = await dapi<Channel[]>(`/guilds/${guild.id}/channels`);
  const textChannels = channels.filter((c) => c.type === 0).sort((a, b) => a.position - b.position);
  const channel = textChannels[0];
  if (!channel) throw new Error(`サーバー「${guild.name}」に閲覧可能なテキストチャンネルがありません。`);

  setEnvVar("JARVIS_GUILD_ID", guild.id);
  setEnvVar("JARVIS_CHANNEL_ID", channel.id);

  console.log("\n✓ 専用サーバーを検出し、.env に記録しました");
  console.log("──────────────────────────────────────────");
  console.log(`  サーバー   : ${guild.name} (${guild.id})`);
  console.log(`  チャンネル : #${channel.name} (${channel.id})`);
  if (guilds.length > 1) {
    console.log(`  ※ 参加サーバーが複数あります。別のサーバーを使うなら .env の JARVIS_GUILD_ID を書き換えて再実行してください。`);
  }
  console.log("──────────────────────────────────────────");
  console.log(`\n  Bot 追加用 招待 URL（別サーバーにも入れたいとき）:\n  ${inviteUrl}\n`);
  console.log("  この後: `./boot.sh` で起動 → #" + channel.name + " で @JARVIS にメンション\n");
}

main().catch((err) => {
  console.error("\n✗ セットアップ失敗:\n", err.message ?? err);
  process.exit(1);
});
