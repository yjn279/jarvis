#!/bin/sh
# discord-channel.sh — Claude Code の Discord チャネルリスナーを起動する。
#
# 公式プラグイン discord@claude-plugins-official を使い、Discord と Claude Code
# セッションを双方向に橋渡しする。Bot はこのプロセスが生きている間だけオンライン。
# `-p`（print）モードは初回応答後すぐ終了し常駐にならないため、対話モードで起動する。
#
# 永続起動（推奨）: screen -dmS discordbot /path/to/discord-channel.sh
# 前面起動:         /path/to/discord-channel.sh
# 画面確認:         screen -r discordbot   （デタッチは Ctrl-a d）
#
# 前提:
#   - bun が入っていること（https://bun.sh）。本スクリプトが ~/.bun/bin を PATH に追加する。
#   - プラグイン導入済み: claude code で /plugin install discord@claude-plugins-official
#   - トークンが ~/.claude/channels/discord/.env の DISCORD_BOT_TOKEN にあること。
#   - アクセス制御は ~/.claude/channels/discord/access.json（access.json.example 参照）。

export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "discord-channel: bun が見つかりません。https://bun.sh からインストールしてください。" >&2
  exit 1
fi

if [ ! -f "$HOME/.claude/channels/discord/.env" ]; then
  echo "discord-channel: トークン未設定です。Claude Code で /discord:configure <token> を実行してください。" >&2
  exit 1
fi

# クラッシュしても自動復帰する常駐ループ。
while true; do
  echo "discord-channel: 起動 $(date)"
  claude --channels plugin:discord@claude-plugins-official
  echo "discord-channel: 終了 (exit=$?) → 5秒後に再起動"
  sleep 5
done
