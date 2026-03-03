import { listAllSessions, type SessionEntry } from "./session-registry";

export async function getSessionsForAgentInDateRange(
  agent: string,
  dateStart: string,
  dateEnd: string
): Promise<SessionEntry[]> {
  const all = await listAllSessions();
  return all.filter(s => {
    if (s.agent !== agent) return false;
    if (!s.dateCreated) return false;
    return s.dateCreated >= dateStart && s.dateCreated <= dateEnd;
  });
}

export async function getActiveSessionByAgent(
  agent: string
): Promise<SessionEntry | null> {
  const all = await listAllSessions();
  const active = all.filter(s => s.agent === agent && !s.group.includes("__archived_"));
  if (!active.length) return null;
  return active.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];
}

export async function getArchivedSessionsByAgent(
  agent: string
): Promise<SessionEntry[]> {
  const all = await listAllSessions();
  return all
    .filter(s => s.agent === agent && s.group.includes("__archived_"))
    .sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}
