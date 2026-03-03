import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
  },
  telegram: { token: "", allowedUserIds: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  whatsapp: {
    enabled: false,
    accessToken: "",
    phoneNumberId: "",
    verifyToken: "",
    allowedSender: "",
    port: 9998,
    sessionGroup: "whatsapp",
  },
  sidecarProcesses: [],
  agents: undefined,
  subagentDetection: undefined,
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface SecretaryTelegramConfig {
  token?: string;
  chatId?: number;
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface SessionRotationConfig {
  threshold: number;
  enabled: boolean;
}

export interface SidecarProcess {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  enabled: boolean;
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  secretaryTelegram?: SecretaryTelegramConfig;
  security: SecurityConfig;
  web: WebConfig;
  whatsapp: WhatsAppConfig;
  sessionRotation?: SessionRotationConfig;
  sidecarProcesses: SidecarProcess[];
  agents?: {
    main?: AgentModelConfig;
    secretary?: AgentModelConfig;
  };
  subagentDetection?: SubagentDetectionConfig;
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface WhatsAppConfig {
  enabled: boolean;
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  allowedSender: string;
  port: number;
  sessionGroup: string;
}

export interface AgentModelConfig {
  model: string;
  subagentModel?: string;
  subagentTasks?: string[];
}

export interface SubagentDetectionConfig {
  enabled: boolean;
  wahaKeywords?: string[];
  obsidianKeywords?: string[];
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(JOBS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseSettings(raw: Record<string, any>): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
    },
    telegram: {
      token: raw.telegram?.token ?? "",
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
    },
    secretaryTelegram: raw.secretaryTelegram ? {
      token: raw.secretaryTelegram.token ?? "",
      chatId: raw.secretaryTelegram.chatId ?? 0,
    } : undefined,
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
    },
    whatsapp: {
      enabled: raw.whatsapp?.enabled ?? false,
      accessToken: raw.whatsapp?.accessToken ?? "",
      phoneNumberId: raw.whatsapp?.phoneNumberId ?? "",
      verifyToken: raw.whatsapp?.verifyToken ?? "",
      allowedSender: raw.whatsapp?.allowedSender ?? "",
      port: Number.isFinite(raw.whatsapp?.port) ? Number(raw.whatsapp.port) : 9998,
      sessionGroup: raw.whatsapp?.sessionGroup ?? "whatsapp",
    },
    sessionRotation: raw.sessionRotation ? {
      threshold: Number.isFinite(raw.sessionRotation?.threshold) ? Number(raw.sessionRotation.threshold) : 120000,
      enabled: raw.sessionRotation?.enabled !== false,
    } : undefined,
    sidecarProcesses: parseSidecarProcesses(raw.sidecarProcesses),
    agents: raw.agents ? {
      main: raw.agents.main ? {
        model: typeof raw.agents.main.model === "string" ? raw.agents.main.model.trim() : "",
        subagentModel: typeof raw.agents.main.subagentModel === "string" ? raw.agents.main.subagentModel.trim() : undefined,
        subagentTasks: Array.isArray(raw.agents.main.subagentTasks) ? raw.agents.main.subagentTasks : undefined,
      } : undefined,
      secretary: raw.agents.secretary ? {
        model: typeof raw.agents.secretary.model === "string" ? raw.agents.secretary.model.trim() : "",
        subagentModel: typeof raw.agents.secretary.subagentModel === "string" ? raw.agents.secretary.subagentModel.trim() : undefined,
        subagentTasks: Array.isArray(raw.agents.secretary.subagentTasks) ? raw.agents.secretary.subagentTasks : undefined,
      } : undefined,
    } : undefined,
    subagentDetection: raw.subagentDetection ? {
      enabled: raw.subagentDetection.enabled !== false,
      wahaKeywords: Array.isArray(raw.subagentDetection.wahaKeywords) ? raw.subagentDetection.wahaKeywords : undefined,
      obsidianKeywords: Array.isArray(raw.subagentDetection.obsidianKeywords) ? raw.subagentDetection.obsidianKeywords : undefined,
    } : undefined,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a: number, b: number) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseSidecarProcesses(value: unknown): SidecarProcess[] {
  if (!Array.isArray(value)) return [];
  const out: SidecarProcess[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (!name || !command) continue;
    out.push({
      name,
      command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      cwd: typeof entry.cwd === "string" ? entry.cwd.trim() : undefined,
      enabled: entry.enabled !== false,
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const raw = await Bun.file(SETTINGS_FILE).json();
  cached = parseSettings(raw);
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const raw = await Bun.file(SETTINGS_FILE).json();
  cached = parseSettings(raw);
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
