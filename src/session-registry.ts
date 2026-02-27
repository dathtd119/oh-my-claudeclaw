import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

const SESSIONS_DIR = join(process.cwd(), ".claude", "claudeclaw", "sessions");
const REGISTRY_FILE = join(SESSIONS_DIR, "registry.json");

export interface SessionEntry {
  sessionId: string;
  group: string;
  createdAt: string;
  lastUsedAt: string;
  contentTokens: number;
  summary?: string;
}

interface Registry {
  sessions: SessionEntry[];
}

let cached: Registry | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
}

async function load(): Promise<Registry> {
  if (cached) return cached;
  try {
    cached = await Bun.file(REGISTRY_FILE).json();
    return cached!;
  } catch {
    cached = { sessions: [] };
    return cached;
  }
}

async function save(registry: Registry): Promise<void> {
  await ensureDir();
  cached = registry;
  const tmp = REGISTRY_FILE + ".tmp";
  await Bun.write(tmp, JSON.stringify(registry, null, 2) + "\n");
  const { rename } = await import("fs/promises");
  await rename(tmp, REGISTRY_FILE);
}

export async function getSessionForGroup(group: string): Promise<SessionEntry | null> {
  const reg = await load();
  const entry = reg.sessions.find((s) => s.group === group);
  if (entry) {
    entry.lastUsedAt = new Date().toISOString();
    await save(reg);
  }
  return entry ?? null;
}

export async function createSessionForGroup(group: string, sessionId: string): Promise<SessionEntry> {
  const reg = await load();
  const existing = reg.sessions.findIndex((s) => s.group === group);
  const entry: SessionEntry = {
    sessionId,
    group,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    contentTokens: 0,
  };
  if (existing >= 0) {
    reg.sessions[existing] = entry;
  } else {
    reg.sessions.push(entry);
  }
  await save(reg);
  return entry;
}

export async function updateTokenCount(group: string, tokens: number): Promise<void> {
  const reg = await load();
  const entry = reg.sessions.find((s) => s.group === group);
  if (entry) {
    entry.contentTokens = tokens;
    await save(reg);
  }
}

export async function rotateSession(group: string, summary?: string): Promise<string | null> {
  const reg = await load();
  const idx = reg.sessions.findIndex((s) => s.group === group);
  if (idx < 0) return null;

  const old = reg.sessions[idx];
  if (summary) old.summary = summary;

  // Move to archive naming
  const archiveGroup = `${group}__archived_${Date.now()}`;
  old.group = archiveGroup;
  await save(reg);
  return old.sessionId;
}

export async function listSessions(): Promise<SessionEntry[]> {
  const reg = await load();
  return reg.sessions.filter((s) => !s.group.includes("__archived_"));
}

export async function listAllSessions(): Promise<SessionEntry[]> {
  const reg = await load();
  return [...reg.sessions];
}

/** Invalidate in-memory cache so next read hits disk. */
export function invalidateCache(): void {
  cached = null;
}
