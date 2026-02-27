import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export async function findTranscriptPath(sessionId: string): Promise<string | null> {
  const filename = `${sessionId}.jsonl`;
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(PROJECTS_DIR, dir, filename);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Estimate content tokens in a session JSONL file.
 * Streams the file, extracts message content strings, sums char lengths / 3.7.
 * ~55ms for a 6MB file.
 */
export async function estimateSessionTokens(sessionId: string): Promise<number> {
  const path = await findTranscriptPath(sessionId);
  if (!path) return 0;

  const file = Bun.file(path);
  const text = await file.text();
  let totalChars = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // Claude JSONL has message objects with content
      if (obj.message?.content) {
        const content = obj.message.content;
        if (typeof content === "string") {
          totalChars += content.length;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.text) totalChars += block.text.length;
            if (block.content) totalChars += String(block.content).length;
          }
        }
      }
      // Also count tool results
      if (obj.result?.content) {
        const content = obj.result.content;
        if (typeof content === "string") {
          totalChars += content.length;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.text) totalChars += block.text.length;
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return Math.round(totalChars / 3.7);
}
