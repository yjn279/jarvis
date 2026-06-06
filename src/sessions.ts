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
   * index.ts で makeRemoteControlName(thread) を呼び出し、remoteControlNameOverride として渡される。
   */
  remoteControlName: string;
  createdAt: string;
  updatedAt: string;
}

type Store = Record<string, SessionEntry>;

const file = config.sessionsFile;
let store: Store = read();

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

/** スレッドに紐づくセッションエントリを返す（無ければ undefined）。 */
export function getSession(threadId: string): SessionEntry | undefined {
  return store[threadId];
}

/** スレッド↔セッションの対応を記録（既存なら updatedAt のみ更新）。 */
export function setSession(threadId: string, entry: SessionEntry): void {
  const now = new Date().toISOString();
  const existing = store[threadId];
  store[threadId] = {
    ...entry,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  persist();
}

/**
 * スレッドに紐づくセッションを解決し、必要なら新規に採番して永続化する。
 *
 * - 初回呼び出し: uuid を採番し、cwd・remoteControlName・channelId を確定して保存する。
 * - 以降の呼び出し: 既存エントリをそのまま返す（uuid・cwd・remoteControlName は不変）。
 *
 * 戻り値の `isNew` が true のとき M3 は `--session-id <uuid>` を、
 * false のとき `--resume <uuid>` を使う。
 */
export async function ensureSession(
  threadId: string,
  channelId: string,
  cwd: string,
  remoteControlNameOverride?: string
): Promise<SessionEntry & { isNew: boolean }> {
  const existing = getSession(threadId);
  if (existing) {
    return { ...existing, isNew: false };
  }

  const sessionId = crypto.randomUUID();
  // makeRemoteControlName(thread) で生成した名前を呼び出し元から渡す。未指定時は threadId の末尾から生成する。
  const remoteControlName = remoteControlNameOverride ?? `dcc-${threadId.slice(-8)}`;

  const now = new Date().toISOString();
  const entry: SessionEntry = {
    sessionId,
    channelId,
    cwd,
    remoteControlName,
    createdAt: now,
    updatedAt: now,
  };

  // in-memory マップへの登録を await なしの同期処理で完結させ、
  // 同一スレッドへの同時リクエストによる二重採番を防ぐ。
  // persist() も同期関数のため、store への書き込みから永続化まで途切れなく実行される。
  store[threadId] = entry;
  persist();

  return { ...entry, isNew: true };
}
