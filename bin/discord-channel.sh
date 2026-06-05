#!/bin/sh
# discord-channel.sh — この自作チャネルプラグイン（Jarvis）を常駐起動する。
#
# 公式 discord プラグインをフォークし、チャンネルでの@メンション時にスレッドを
# 自動生成して以降はスレッド内で会話を続ける。Bot はこのプロセスが生きている間
# だけオンライン。`-p`（print）モードは初回応答後すぐ終了し常駐にならないため、
# 対話モードで起動する。dev-channels の確認プロンプトは bin/pty-confirm.py が
# 自動で Enter を送るので、screen -dmS による非対話の常駐起動でもそのまま動く。
#
# 永続起動（推奨）: screen -dmS discordbot /path/to/jarvis/bin/discord-channel.sh
# 前面起動:         ./bin/discord-channel.sh
# 画面確認:         screen -r discordbot   （デタッチは Ctrl-a d）
#
# 前提:
#   - bun が入っていること（https://bun.sh）。本スクリプトが ~/.bun/bin を PATH に追加する。
#   - python3 が入っていること（dev-channels 確認への自動応答に使う。macOS は標準で同梱）。
#   - トークンが ~/.claude/channels/discord/.env の DISCORD_BOT_TOKEN にあること。
#   - アクセス制御は ~/.claude/channels/discord/access.json（access.json.example 参照、
#     既存の /discord:access スキルでそのまま管理できる）。
#
# 研究プレビュー中、自作チャネルは承認許可リストに無いため
# --dangerously-load-development-channels で読み込む（許可リストのみバイパスし、
# 組織ポリシーは有効のまま）。.mcp.json と server.ts を見つけるためリポジトリ直下で起動する。

export PATH="$HOME/.bun/bin:$PATH"

# リポジトリ直下（このスクリプトの親の親）へ移動する。
cd "$(dirname "$0")/.." || exit 1

if ! command -v bun >/dev/null 2>&1; then
  echo "jarvis: bun が見つかりません。https://bun.sh からインストールしてください。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "jarvis: python3 が見つかりません（dev-channels 確認の自動応答に必要）。" >&2
  exit 1
fi

if [ ! -f "$HOME/.claude/channels/discord/.env" ]; then
  echo "jarvis: トークン未設定です。Claude Code で /discord:configure <token> を実行してください。" >&2
  exit 1
fi

# クラッシュしても自動復帰する常駐ループ。
# dev-channels の確認プロンプトに Enter を自動で送るため PTY ラッパ経由で起動する。
while true; do
  echo "jarvis: 起動 $(date)"
  python3 bin/pty-confirm.py claude --dangerously-load-development-channels server:jarvis
  echo "jarvis: 終了 (exit=$?) → 5秒後に再起動"
  sleep 5
done
