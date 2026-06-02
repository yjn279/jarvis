#!/bin/sh
# Jarvis supervisor — クラッシュしても自動で再起動する常駐ループ。
# 参考: GOROman/nullevi03 の boot.sh（claude を無限ループで起動し続ける思想）。

cd "$(dirname "$0")" || exit 1

if [ ! -f .env ]; then
  echo "✗ .env がありません。 cp .env.example .env して DISCORD_BOT_TOKEN を設定してください。"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 依存をインストールします…"
  npm install
fi

FIRST=1
while true; do
  if [ "$FIRST" = "1" ]; then
    FIRST=0
  else
    echo "🤵 Jarvis が終了しました → 5秒後に再起動します"
    sleep 5
  fi
  echo "🤵 Jarvis を起動します: $(date)"
  npm start
  echo "🤵 Jarvis プロセス終了 (exit=$?)"
done
