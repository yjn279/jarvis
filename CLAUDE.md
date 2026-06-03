# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Jarvis は Discord 上で動く個人用AI秘書である。 [GOROman/nullevi03](https://github.com/GOROman/nullevi03) を参考に、 `claude` CLI をヘッドレス実行する薄いラッパーとして実装されている。秘書の頭脳は Claude Code 本体であり、本リポジトリは Discord との接続と、会話の対応付けだけを担う。

設計の核心は「Discord スレッド ↔ Claude セッションの 1 対 1 対応」である。各スレッドに `session_id` を割り当て、 `claude -p --resume <id> --output-format json` で継続することで、過去の文脈をセッション履歴として引き継ぐ。独自のDBや検索層は持たない。

## Architecture

責務をファイル単位で分離している。各モジュールの役割を次に示す。

| ファイル | 役割 |
| :-- | :-- |
| `src/index.ts` | Discord イベントを受け、会話をルーティングする入口。 |
| `src/claude.ts` | `claude` をヘッドレス実行し、応答と `session_id` を返す。 |
| `src/sessions.ts` | `threadId` ↔ `sessionId` の対応表を JSON で永続化する。 |
| `src/discord.ts` | メンション除去・分割送信・入力中表示・履歴整形の補助。 |
| `src/setup-server.ts` | Bot の参加サーバーを一覧表示し、追加用の招待 URL を案内する。 |
| `src/persona.ts` | 秘書の人格。システムプロンプトへ追記される。 |
| `src/config.ts` | 環境変数を一箇所で解決し型付きで配る。 |

ルーティングの原則は、チャンネルでメンションされたらスレッドを作って新規セッションを開始し、秘書が作ったスレッド内ではメンション不要でセッションを継続する、というものである。参加中のどのサーバー・チャンネルでも同様に動き、サーバーやチャンネルを絞る制限は持たない。

## Commands

開発で使うコマンドを次に示す。

- `npm run typecheck` で型検査する。
- `npm start` で Bot を起動する（ `.env` の `DISCORD_BOT_TOKEN` が必要）。
- `npm run setup` で参加サーバーの確認と招待 URL の表示を行う。
- `./boot.sh` で常駐起動する（クラッシュ時に自動再起動）。

## Conventions

編集時に守る方針を次に示す。

- 認証情報は `.env` と `~/.claude` 配下にのみ置き、リポジトリへコミットしない。 `.env` ・ `data/` ・ `workspace/` は `.gitignore` 済みである。
- セッションの対応付けは `claude` が返す `session_id` を保存して `--resume` する方式を崩さない。スレッドとセッションの 1 対 1 対応がこのプロジェクトの本質である。
- 実行は Claude Code のサブスクリプション認証を前提とする。API キーへ切り替える変更は挙動を大きく変えるため、ユーザー確認を取る。
- 依存は最小限に保つ。 `discord.js` と `dotenv` 以外を足す前に、標準機能で済まないかを検討する。
