import { join } from "path";
import { existsSync } from "fs";
import { type Settings } from "./config";
import { type SubagentTask } from "./subagent";
import { localLlmChat } from "./local-llm";

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
 * Classify a Telegram message. Tries local LLM first (fast, free),
 * falls back to Haiku via claude CLI on failure.
 */
export async function classifyMessage(text: string): Promise<ClassifyResult> {
  // Try local LLM first
  const localResult = await classifyWithLocalLlm(text);
  if (localResult) return localResult;

  // Fallback: Haiku via claude CLI
  console.log("[router] Local LLM unavailable, falling back to Haiku");
  return classifyWithHaiku(text);
}

async function classifyWithLocalLlm(text: string): Promise<ClassifyResult | null> {
  const response = await localLlmChat([
    {
      role: "system",
      content: 'Classify this Telegram message as "secretary" (PostSale work, WhatsApp, network incidents, partner/customer communication, MINEDU, COAR, B2B) or "general" (everything else). Respond with ONLY valid JSON: {"category":"secretary"|"general","reason":"brief reason"}',
    },
    { role: "user", content: text.slice(0, 500) },
  ], { maxTokens: 80 });

  if (!response) return null;

  try {
    const jsonMatch = response.match(/\{[\s\S]*"category"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.category === "secretary" || parsed.category === "general") {
        return { category: parsed.category, reason: `local_llm: ${parsed.reason ?? "classified"}` };
      }
    }
  } catch {}
  return null;
}

async function classifyWithHaiku(text: string): Promise<ClassifyResult> {
  const prompt = await buildClassifierPrompt(text);
  try {
    const proc = Bun.spawn(
      [
        "claude", "-p", prompt,
        "--model", "haiku",
        "--output-format", "json",
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

const CLASSIFY_PROMPT_PATH = join(process.cwd(), "prompts", "router", "CLASSIFY.md");
let classifyTemplate: string | null = null;

async function loadClassifyTemplate(): Promise<string> {
  if (classifyTemplate) return classifyTemplate;
  try {
    classifyTemplate = await Bun.file(CLASSIFY_PROMPT_PATH).text();
  } catch {
    classifyTemplate = `Classify this message as "secretary" (PostSale work) or "general" (everything else). Respond JSON only: {"category":"secretary"|"general","reason":"brief"}\n\n{{MESSAGE}}`;
  }
  return classifyTemplate;
}

async function buildClassifierPrompt(text: string): Promise<string> {
  const template = await loadClassifyTemplate();
  return template.replace("{{MESSAGE}}", text.slice(0, 500));
}

/**
 * Detect which subagent tasks should be spawned based on message content.
 * Supports per-agent config (new format) and global config (legacy).
 * When strategy is "llm", tries local LLM first, falls back to keywords.
 */
export async function detectSubagentTasks(message: string, settings: Settings, agentName?: string): Promise<SubagentTask[]> {
  // Try per-agent config first (new format)
  if (agentName && settings.agents) {
    const agent = (settings.agents as any)[agentName];
    if (agent?.subagentDetection) {
      const detection = agent.subagentDetection;
      if (!detection.enabled) return [];

      const strategy = detection.strategy ?? "keywords";

      // Try LLM strategy
      if (strategy === "llm" || strategy === "hybrid") {
        const llmResult = await detectWithLocalLlm(message, detection.tasks);
        if (llmResult.length > 0) return llmResult;
        if (strategy === "llm") return []; // LLM-only, no fallback to keywords
      }

      // Keywords strategy (or hybrid fallback)
      return detectWithKeywords(message, detection.tasks);
    }
  }

  // Legacy: global subagentDetection config
  const detection = settings.subagentDetection;
  if (!detection?.enabled) return [];

  const lower = message.toLowerCase();
  const tasks: SubagentTask[] = [];

  const wahaKeywords = detection.wahaKeywords ?? [
    "whatsapp", "tin nhắn", "nhắn tin", "message", "chat", "waha", "contact", "liên hệ",
  ];
  const obsidianKeywords = detection.obsidianKeywords ?? [
    "obsidian", "postsale", "note", "ghi chú", "sync", "cập nhật", "tổng hợp", "report",
  ];

  if (wahaKeywords.some((k) => lower.includes(k.toLowerCase()))) tasks.push("whatsapp_read");
  if (obsidianKeywords.some((k) => lower.includes(k.toLowerCase()))) tasks.push("obsidian_sync");

  return tasks;
}

function detectWithKeywords(message: string, tasks: Record<string, any>): SubagentTask[] {
  const lower = message.toLowerCase();
  const result: SubagentTask[] = [];
  for (const [taskName, cfg] of Object.entries(tasks)) {
    const keywords: string[] = cfg?.keywords ?? [];
    if (keywords.some((k: string) => lower.includes(k.toLowerCase()))) {
      result.push(taskName as SubagentTask);
    }
  }
  return result;
}

async function detectWithLocalLlm(message: string, tasks: Record<string, any>): Promise<SubagentTask[]> {
  const taskList = Object.entries(tasks)
    .map(([name, cfg]) => `"${name}": ${cfg?.description ?? name}`)
    .join(", ");
  const taskNames = Object.keys(tasks).map(n => `"${n}"`).join(", ");

  const response = await localLlmChat([
    {
      role: "system",
      content: `Return ONLY a JSON array of task names needed from: [${taskNames}]. Tasks: ${taskList}. Return [] if none apply.`,
    },
    { role: "user", content: message.slice(0, 500) },
  ], { maxTokens: 50 });

  if (!response) return [];

  try {
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      const validNames = new Set(Object.keys(tasks));
      return parsed.filter(t => validNames.has(t)) as SubagentTask[];
    }
  } catch {}
  return [];
}
