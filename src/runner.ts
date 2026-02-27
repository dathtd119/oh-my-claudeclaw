import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { getSession, createSession } from "./sessions";
import {
  getSessionForGroup,
  createSessionForGroup,
  updateTokenCount,
  rotateSession,
} from "./session-registry";
import { estimateSessionTokens } from "./token-estimator";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
const HEARTBEAT_PROMPT_FILE = join(PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

const DEFAULT_ROTATION_THRESHOLD = 120_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  sessionGroup?: string;
  model?: string;
  tools?: string;
  settingSources?: string;
  effort?: string;
  maxTurns?: number;
  noSessionPersistence?: boolean;
}

const RATE_LIMIT_PATTERN = /you(?:'|')ve hit your limit/i;

// Per-group serial queues — prevents concurrent --resume on same session
const groupQueues: Map<string, Promise<unknown>> = new Map();
let statelessCounter = 0;

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = groupQueues.get(key) ?? Promise.resolve();
  const task = prev.then(fn, fn);
  groupQueues.set(key, task.catch(() => {}));
  return task;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  for (const text of [stdout, stderr]) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  const [rawStdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  return { rawStdout, stderr, exitCode: proc.exitCode ?? 1 };
}

const PROJECT_DIR = process.cwd();

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [CLAUDECLAW_BLOCK_START, promptContent, CLAUDECLAW_BLOCK_END].join("\n");

  let content = "";
  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
    case "unrestricted":
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

async function loadPrompts(): Promise<string> {
  const selectedPromptFiles = [
    join(PROMPTS_DIR, "IDENTITY.md"),
    join(PROMPTS_DIR, "USER.md"),
    join(PROMPTS_DIR, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

export async function loadHeartbeatPromptTemplate(): Promise<string> {
  try {
    return (await Bun.file(HEARTBEAT_PROMPT_FILE).text()).trim();
  } catch {
    return "";
  }
}

async function checkAndRotate(group: string): Promise<void> {
  const entry = await getSessionForGroup(group);
  if (!entry) return;

  const tokens = await estimateSessionTokens(entry.sessionId);
  await updateTokenCount(group, tokens);

  const settings = getSettings();
  const threshold = settings.sessionRotation?.threshold ?? DEFAULT_ROTATION_THRESHOLD;
  if (tokens < threshold) return;

  console.log(
    `[${new Date().toLocaleTimeString()}] Session ${group} at ${tokens} tokens (threshold ${threshold}), rotating...`
  );
  await rotateSession(group, `Auto-rotated at ${tokens} tokens`);
}

async function execClaude(name: string, prompt: string, options?: RunOptions): Promise<RunResult> {
  await mkdir(LOGS_DIR, { recursive: true });

  const group = options?.sessionGroup ?? "default";

  let existing: { sessionId: string } | null = null;
  if (!options?.noSessionPersistence) {
    if (options?.sessionGroup) await checkAndRotate(group);
    existing = options?.sessionGroup
      ? await getSessionForGroup(group)
      : await getSession();
  }

  const isNew = !existing;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const modelOverride = options?.model;
  const primaryConfig: ModelConfig = {
    model: modelOverride ?? settings.model,
    api: settings.api,
  };
  const fallbackConfig: ModelConfig = {
    model: settings.fallback?.model ?? "",
    api: settings.fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(settings.security);

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (group=${group}, ${isNew ? "new session" : `resume ${existing!.sessionId.slice(0, 8)}`}, security: ${settings.security.level})`
  );

  const outputFormat = isNew ? "json" : "text";
  const args = ["claude", "-p", prompt, "--output-format", outputFormat, ...securityArgs];

  if (!isNew) {
    args.push("--resume", existing!.sessionId);
  }

  // Apply per-job CLI overrides
  if (options?.noSessionPersistence) {
    args.push("--no-input");
  }
  if (options?.tools) {
    const toolsIdx = args.indexOf("--tools");
    if (toolsIdx >= 0) args.splice(toolsIdx, 2);
    args.push("--tools", options.tools);
  }
  if (options?.settingSources) {
    args.push("--setting-sources", options.settingSources);
  }
  if (options?.effort) {
    args.push("--effort", options.effort);
  }
  if (options?.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  // Append system prompt
  const promptContent = await loadPrompts();
  const appendParts: string[] = ["You are running inside ClaudeClaw."];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (settings.security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv);
    usedFallback = true;
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;
  let stdout = rawStdout;
  let sessionId = existing?.sessionId ?? "unknown";
  const rateLimitMessage = extractRateLimitMessage(rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  if (!rateLimitMessage && isNew && exitCode === 0) {
    try {
      const json = JSON.parse(rawStdout);
      sessionId = json.session_id;
      stdout = json.result ?? "";
      if (options?.sessionGroup) {
        await createSessionForGroup(group, sessionId);
      } else if (!options?.noSessionPersistence) {
        await createSession(sessionId);
      }
      console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId} (group=${group})`);
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to parse session from Claude output:`, e);
    }
  }

  const result: RunResult = { stdout, stderr, exitCode };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"}, group=${group})`,
    `Model: ${usedFallback ? "fallback" : "primary"}${modelOverride ? ` (override: ${modelOverride})` : ""}`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  return result;
}

export async function run(name: string, prompt: string, options?: RunOptions): Promise<RunResult> {
  if (options?.noSessionPersistence) {
    const key = `__stateless_${++statelessCounter}`;
    return enqueue(key, () => execClaude(name, prompt, options));
  }
  const group = options?.sessionGroup ?? "default";
  return enqueue(group, () => execClaude(name, prompt, options));
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(name: string, prompt: string, options?: RunOptions): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), options);
}

export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", "Wakeup, my friend!");
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
