import { join } from "path";
import { existsSync } from "fs";

const MAP_FILE = join(process.cwd(), ".claude", "claudeclaw", "sessions", "message-map.json");
const MAX_ENTRIES = 500;

// In-memory map: botMessageId → sessionGroup
let messageSessionMap: Map<number, string> = new Map();
let mapLoaded = false;

async function loadMap(): Promise<void> {
  if (mapLoaded) return;
  mapLoaded = true;
  try {
    if (!existsSync(MAP_FILE)) return;
    const data = await Bun.file(MAP_FILE).json() as Array<[number, string]>;
    messageSessionMap = new Map(data);
  } catch {
    messageSessionMap = new Map();
  }
}

async function saveMap(): Promise<void> {
  const entries = [...messageSessionMap.entries()];
  // Prune to last MAX_ENTRIES
  const pruned = entries.slice(-MAX_ENTRIES);
  messageSessionMap = new Map(pruned);
  await Bun.write(MAP_FILE, JSON.stringify(pruned));
}

export async function recordMessageSession(botMessageId: number, group: string): Promise<void> {
  await loadMap();
  messageSessionMap.set(botMessageId, group);
  await saveMap();
}

export async function routeByReplyTo(replyToMessageId: number): Promise<string | null> {
  await loadMap();
  return messageSessionMap.get(replyToMessageId) ?? null;
}

export interface ClassifyResult {
  category: "secretary" | "general";
  reason: string;
}

/**
 * Classify a Telegram message using a stateless Haiku call.
 * Returns the category for session routing.
 */
export async function classifyMessage(text: string): Promise<ClassifyResult> {
  const prompt = buildClassifierPrompt(text);

  try {
    const proc = Bun.spawn(
      [
        "claude", "-p", prompt,
        "--model", "haiku",
        "--output-format", "json",
        "--no-input",
        "--max-turns", "1",
        "--dangerously-skip-permissions",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return { category: "general", reason: "classifier_error" };
    }

    const parsed = JSON.parse(stdout);
    const result = parsed.result ?? stdout;

    // Try to extract JSON from the result
    const jsonMatch = String(result).match(/\{[\s\S]*"category"[\s\S]*\}/);
    if (jsonMatch) {
      const classification = JSON.parse(jsonMatch[0]);
      if (classification.category === "secretary") {
        return { category: "secretary", reason: classification.reason ?? "classified" };
      }
    }
    return { category: "general", reason: "default" };
  } catch {
    return { category: "general", reason: "classifier_fallback" };
  }
}

function buildClassifierPrompt(text: string): string {
  return `You are a message classifier. Classify this Telegram message into exactly one category.

Categories:
- "secretary": Messages about PostSale work — WhatsApp alerts, customer issues, network incidents, partner escalations, project status (MINEDU, COAR, PRONATEL), team coordination, department mentions (NOC, PMO, SMO, KAM, Presale, TRA, IP, Infrastructure). Also messages starting with "sec " or mentioning postsale-secretary.
- "general": Everything else — personal questions, general AI queries, coding help, casual conversation.

Message: "${text.replace(/"/g, '\\"').slice(0, 500)}"

Respond with ONLY valid JSON: {"category": "secretary" or "general", "reason": "brief reason"}`;
}
