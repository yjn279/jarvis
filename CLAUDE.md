# CLAUDE.md

`claude` を Discord から呼び出すスタンドアロン Bot（discord-claude-code）。仕様・設計・環境変数は [README.md](README.md) と [docs/interactive-ui.md](docs/interactive-ui.md) に集約する。本ファイルには、コードからは読み取れない運用上の非自明な注意点のみを記載する。

## Operations

### Shared Token

本 Bot と常駐アシスタント（公式 channel plugin）は同一の Discord Bot トークンを使う。Discord は同一トークンで Gateway 接続を1つしか許可しないため、両者を同時に起動すると接続を奪い合い、二重応答や接続の不安定化を招く。本 Bot を起動する前に、必ず常駐アシスタントを停止する（背景は README の「Token Conflict」を参照）。

### Stopping the Assistant

常駐アシスタントは `screen -dmS discord` の中で `confirm-loop.py` が `claude … plugin:discord` を `while true` ループで常駐管理する構成で動く。

ここで注意すべきは、`screen -S discord -X quit` が screen マネージャを終了させるだけで、配下の `confirm-loop.py` と `claude` は孤児化して動き続ける点である。screen を quit しただけでは Discord への応答もトークン競合も止まらない。

確実に停止するには、ループ本体ごとプロセスツリーを止める。次の `pkill` は bash の `while true` ループ・`confirm-loop.py`・screen のいずれの行にもマッチするため、再起動ループを含めて一括で停止できる。`while true` ループを残したまま `claude` だけを kill すると 5 秒後に再起動される点に注意する。

```sh
pkill -f confirm-loop.py
# 取りこぼしがないことを確認する（出力が空なら完全停止）
ps aux | grep -E "[c]onfirm-loop|[d]angerously-load-development-channels"
```

### Restarting the Assistant

停止後に常駐へ戻すときは、元の supervisor をそのまま再生成する。

```sh
screen -dmS discord bash -lc 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; cd "$HOME"; while true; do python3 /Users/yuji/.claude/channels/discord/confirm-loop.py claude --dangerously-load-development-channels plugin:discord@claude-discord-plugin; sleep 5; done >> /tmp/discord-plugin.log 2>&1'
```

復元後は `screen -ls` に `discord` セッションが現れ、`claude … plugin:discord` プロセスが起動することを確認する。Discord 側ではメンバー一覧で Bot がオンライン表示になることを確認する。
