import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/** 1つの Discord スレッドに対応する Claude Code セッション。 */
export interface SessionEntry {
  /** claude のセッション UUID（--session-id / --resume の引数）。 */
  sessionId: string;
  /** 親チャンネル ID（参照用）。 */
  channelId: string;
  /** このセッションで claude を起動する作業ディレクトリの絶対パス。 */
  cwd: string;
  /**
   * --remote-control に渡す安定名。
   * index.ts で makeRemoteControlName(thread) を生成し、ensureSession に渡す。
   */
  remoteControlName: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, SessionEntry>;

const file = config.sessionsFile;

/** ディスクへ確定済みのセッション（runClaude 初回成功を経たもの）。 */
let store: Store = read();

/**
 * まだ確定していない新規セッションの予約。
 * `ensureSession` で採番したエントリはここに置き、`commitSession`（初回 runClaude 成功）で
 * `store` へ昇格・永続化する。`rollbackSession`（初回失敗）で破棄する。
 * メモリ上のみに留めることで、claude 側に存在しない UUID をディスクへ書き残さない（#5）。
 */
const pending = new Map<string, SessionEntry>();

function read(): Store {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Store;
  } catch {
    return {};
  }
}

function persist(): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file); // アトミックに差し替え、書き込み中断による破損を防ぐ
}

/**
 * スレッドに紐づく確定済みセッションを返す（無ければ undefined）。
 * 予約中（初回 runClaude 未成功）のセッションは「既知」とはみなさないため返さない。
 */
export function getSession(threadId: string): SessionEntry | undefined {
  return store[threadId];
}

/**
 * スレッドに紐づくセッションを解決し、必要なら新規に採番して予約する。
 *
 * - 確定済みエントリがある: そのまま返す（`isNew=false`、`--resume`）。
 * - 予約中エントリがある（初回がまだ成功していない）: 同じ uuid で再試行する（`isNew=true`、`--session-id`）。
 * - どちらも無い: uuid を採番して **予約のみ** 行う（ディスクへは書かない）。`isNew=true`。
 *
 * 採番した新規エントリは {@link commitSession}（初回 runClaude 成功）で初めて永続化する。
 * 失敗時は {@link rollbackSession} で予約を破棄する。これにより claude 側に存在しない
 * UUID がディスクに残り、以降 `--resume` が永久に失敗する事態を防ぐ（#5）。
 *
 * 採番と予約は await を挟まない同期処理で完結させ、同一スレッドへの同時リクエストによる
 * 二重採番を防ぐ。
 */
export async function ensureSession(
  threadId: string,
  channelId: string,
  cwd: string,
  remoteControlName: string
): Promise<SessionEntry & { isNew: boolean }> {
  const committed = store[threadId];
  if (committed) {
    return { ...committed, isNew: false };
  }

  const reserved = pending.get(threadId);
  if (reserved) {
    return { ...reserved, isNew: true };
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const entry: SessionEntry = {
    sessionId,
    channelId,
    cwd,
    remoteControlName,
    createdAt: now,
    updatedAt: now,
  };

  pending.set(threadId, entry); // 予約のみ。確定は commitSession まで遅延する。
  return { ...entry, isNew: true };
}

/**
 * 予約中の新規セッションを確定し、ディスクへ永続化する（初回 runClaude 成功時に呼ぶ）。
 * 予約が無ければ何もしない（resume セッションや二重呼び出しに対して安全）。
 */
export function commitSession(threadId: string): void {
  const reserved = pending.get(threadId);
  if (!reserved) return;
  store[threadId] = reserved;
  pending.delete(threadId);
  persist();
}

/**
 * 予約中の新規セッションを破棄する（初回 runClaude 失敗時に呼ぶ）。
 * ディスクへは未書き込みのため、削除はメモリ上の予約のみで完結する。
 * 確定済み（resume）セッションには触れない＝一時的失敗で既存セッションを壊さない。
 */
export function rollbackSession(threadId: string): void {
  pending.delete(threadId);
}
