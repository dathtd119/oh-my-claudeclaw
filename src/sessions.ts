/**
 * Backward-compatible shim delegating to session-registry.
 * Existing code calling getSession/createSession still works,
 * mapped to the "default" session group.
 */
import { join } from "path";
import { unlink, readdir } from "fs/promises";
import {
  getSessionForGroup,
  createSessionForGroup,
  rotateSession,
  getSessionForAgent,
  checkAndRotateIfNeeded,
  listAllSessions,
  type SessionEntry,
} from "./session-registry";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSION_FILE = join(HEARTBEAT_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
}

export async function getSession(): Promise<{ sessionId: string } | null> {
  const entry = await getSessionForGroup("default");
  return entry ? { sessionId: entry.sessionId } : null;
}

export async function createSession(sessionId: string): Promise<void> {
  await createSessionForGroup("default", sessionId);
}

export async function peekSession(): Promise<GlobalSession | null> {
  const entry = await getSessionForGroup("default");
  if (!entry) return null;
  return {
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
}

export async function resetSession(): Promise<void> {
  await rotateSession("default", "reset by user");
  try { await unlink(SESSION_FILE); } catch { /* already gone */ }
}

export async function backupSession(): Promise<string | null> {
  const entry = await getSessionForGroup("default");
  if (!entry) return null;

  let files: string[];
  try {
    files = await readdir(HEARTBEAT_DIR);
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(HEARTBEAT_DIR, backupName);

  const backupData: GlobalSession = {
    sessionId: entry.sessionId,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  };
  await Bun.write(backupPath, JSON.stringify(backupData, null, 2) + "\n");
  await rotateSession("default", "backed up");

  return backupName;
}

export async function getOrCreateSessionForAgent(agent: string): Promise<SessionEntry> {
  // 1. Check if rotation needed
  await checkAndRotateIfNeeded(agent, new Date());

  // 2. Try to get existing session for today
  let entry = await getSessionForAgent(agent);
  if (entry) {
    return entry; // Reuse
  }

  // 3. Create new session for today
  const today = new Date().toISOString().split("T")[0]; // "2026-03-02"
  const newSessionId = crypto.randomUUID();
  const group = `${agent}_${today}`;

  return await createSessionForGroup(group, newSessionId, agent);
}

export async function listSessionsByAgent(agent: string): Promise<SessionEntry[]> {
  const reg = await listAllSessions();
  return reg.filter((s) => s.agent === agent && !s.group.includes("__archived_"));
}

export async function listArchivedByAgent(agent: string): Promise<SessionEntry[]> {
  const reg = await listAllSessions();
  return reg.filter((s) => s.agent === agent && s.group.includes("__archived_"));
}
