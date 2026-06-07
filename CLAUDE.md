# CLAUDE.md

`claude` を Discord から呼び出すスタンドアロン Bot（discord-claude-code）。仕様・設計・環境変数は [README.md](README.md) と [docs/interactive-ui.md](docs/interactive-ui.md) に集約する。本ファイルには、コードからは読み取れない運用上の非自明な注意点のみを記載する。

## Operations

本 Bot は standalone デーモンとして常駐稼働する。`screen` セッション `dcc` の中で `boot.sh`（`npm start` = `tsx src/index.ts` を無限ループで監視・自動再起動）が動き、`.env` の実トークンで Discord に接続する。クラッシュ時は 5 秒後に自動再起動するが、マシン再起動は生き延びない（launchd 等の自動起動は未設定）。

### Deploying

このワークツリーで以下を実行して常駐させる。`node`（mise shims）と `claude`（`~/.local/bin`）を PATH に通す点が要諦で、これを欠くと SDK が `claude` を spawn できずに無言で失敗する。

```sh
screen -dmS dcc bash -lc 'export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.bun/bin:$PATH"; cd <このワークツリー>; exec sh boot.sh >> /tmp/dcc-standalone.log 2>&1'
```

起動確認は `/tmp/dcc-standalone.log` に `Ready: JARVIS#…` が出ること、Discord のメンバー一覧で Bot がオンライン表示になることの2点で行う。

### Stopping / Restarting

停止は `screen -S dcc -X quit` で screen ごと止める。boot.sh のループも screen 内にあるため、quit で配下の `node` まで停止する。孤児が残った場合のみ `pkill -f "src/index.ts"` で取りこぼす。コード更新後の再起動は `node` を kill すれば boot.sh が 5 秒後に再起動する。

### Shared Token Conflict

Discord は同一トークンの Gateway 接続を実質1つしか有効化しない。同じトークンで接続する別プロセスがあると、接続を奪い合い、メッセージの取りこぼしや二重応答を招く。

過去に本リポジトリ（channel-plugin ブランチ）の `.mcp.json` が `jarvis` MCP（`bun server.ts`）を定義しており、このリポジトリで Claude Code セッションを開くたびに同一トークンで Discord へ接続し、standalone と競合していた。実機検証で最初のメッセージがこの競合接続に奪われ standalone に届かない事象を確認したため、`.mcp.json` から `jarvis` を撤去した（撤去後は走行中セッションも MCP を再生成せず、競合が解消することを確認）。

standalone 稼働中は次を守る。同一トークンの Discord MCP を `.mcp.json` に再追加しない。channel plugin を同トークンで起動しない。恒久的に分離する最も安全な方法は、standalone へ専用の Discord Bot トークンを割り当てることである。
