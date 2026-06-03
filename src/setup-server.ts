import "dotenv/config";

/**
 * 秘書を使えるようにする準備を案内する。
 *
 * Discord は Bot 単独でのサーバー作成（POST /guilds）を禁止しているため、
 * サーバーはユーザーのアカウントで用意し、OAuth 招待 URL で Bot を追加する。
 * 本スクリプトは:
 *
 *   1. トークンを検証する
 *   2. Bot が参加しているサーバーを一覧表示する
 *   3. Bot を追加する OAuth 招待 URL を案内する
 *
 * 秘書は参加中のどのサーバーでも @メンションに応答するため、サーバーや
 * チャンネルを .env に固定する必要はない。
 */

const API = "https://discord.com/api/v10";

// View Channels | Send Messages | Create Public Threads | Send Messages in Threads
// | Read Message History | Add Reactions
const INVITE_PERMISSIONS = "309237713984";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("✗ DISCORD_BOT_TOKEN が未設定です。.env に設定してから再実行してください。");
  process.exit(1);
}

async function dapi<T>(path: string): Promise<T> {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}\n${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Guild {
  id: string;
  name: string;
}

async function main(): Promise<void> {
  const me = await dapi<{ username: string; id: string }>("/users/@me");
  console.log(`Bot: ${me.username} (${me.id})`);

  const inviteUrl =
    `https://discord.com/oauth2/authorize?client_id=${me.id}` +
    `&permissions=${INVITE_PERMISSIONS}&scope=bot`;

  const guilds = await dapi<Guild[]>("/users/@me/guilds");

  if (guilds.length === 0) {
    console.log("\nまだどのサーバーにも参加していません。");
  } else {
    console.log(`\n参加中のサーバー（${guilds.length}）:`);
    for (const g of guilds) console.log(`  - ${g.name} (${g.id})`);
  }

  console.log(`\nBot をサーバーへ追加する招待 URL:\n  ${inviteUrl}\n`);
  console.log("追加したら `./boot.sh` で起動し、そのサーバーで @" + me.username + " にメンションしてください。\n");
}

main().catch((err) => {
  console.error("\n✗ セットアップ失敗:\n", err.message ?? err);
  process.exit(1);
});
