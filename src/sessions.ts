import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/** 1つの Discord スレッドに対応する Claude Code セッション。 */
export interface SessionEntry {
  /** claude のセッションID（--resume の引数）。 */
  sessionId: string;
  /** 親チャンネルID（参照用）。 */
  channelId: string;
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

/** スレッドに紐づくセッションを返す（無ければ undefined）。 */
export function getSession(threadId: string): SessionEntry | undefined {
  return store[threadId];
}

/** スレッド↔セッションの対応を記録（既存なら updatedAt のみ更新）。 */
export function setSession(threadId: string, sessionId: string, channelId: string): void {
  const now = new Date().toISOString();
  const existing = store[threadId];
  store[threadId] = {
    sessionId,
    channelId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  persist();
}
