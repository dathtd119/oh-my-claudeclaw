import { join } from "path";
import { randomUUID } from "crypto";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "heartbeat");
const SESSIONS_FILE = join(HEARTBEAT_DIR, "telegram-sessions.json");

export interface UserSession {
  sessionId: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface TelegramSessions {
  users: Record<string, UserSession>;
}

export async function loadSessions(): Promise<TelegramSessions> {
  try {
    return await Bun.file(SESSIONS_FILE).json();
  } catch {
    return { users: {} };
  }
}

export async function saveSessions(sessions: TelegramSessions): Promise<void> {
  await Bun.write(SESSIONS_FILE, JSON.stringify(sessions, null, 2) + "\n");
}

export async function getOrCreateSession(
  userId: number
): Promise<{ sessionId: string; isNew: boolean }> {
  const sessions = await loadSessions();
  const key = String(userId);

  if (sessions.users[key]) {
    sessions.users[key].lastMessageAt = new Date().toISOString();
    await saveSessions(sessions);
    return { sessionId: sessions.users[key].sessionId, isNew: false };
  }

  const sessionId = randomUUID();
  sessions.users[key] = {
    sessionId,
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  };
  await saveSessions(sessions);
  return { sessionId, isNew: true };
}

export async function deleteSession(userId: number): Promise<void> {
  const sessions = await loadSessions();
  delete sessions.users[String(userId)];
  await saveSessions(sessions);
}
