import { join } from "path";
import { mkdir } from "fs/promises";
import { getOrCreateSession, deleteSession } from "./sessions";

// --- Config ---

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "heartbeat");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  projectPath: string;
}

async function loadConfig(): Promise<TelegramConfig> {
  const settingsFile = Bun.file(join(HEARTBEAT_DIR, "settings.json"));
  const settings = await settingsFile.json();
  const tg = settings.telegram;

  if (!tg?.token) {
    throw new Error("Missing telegram.token in .claude/heartbeat/settings.json");
  }

  return {
    token: tg.token,
    allowedUserIds: tg.allowedUserIds ?? [],
    projectPath: tg.projectPath ?? process.cwd(),
  };
}

// --- Telegram Bot API (raw fetch, zero deps) ---

const API_BASE = "https://api.telegram.org/bot";

interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function callApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Telegram API ${method}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  const MAX_LEN = 4096;
  for (let i = 0; i < text.length; i += MAX_LEN) {
    await callApi(token, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + MAX_LEN),
    });
  }
}

async function sendTyping(token: string, chatId: number): Promise<void> {
  await callApi(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// --- Claude session runner ---

async function runClaude(
  prompt: string,
  projectPath: string,
  sessionId: string,
  isNew: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ["claude", "-p", prompt, "--output-format", "text"];
  if (isNew) {
    args.push("--session-id", sessionId);
  } else {
    args.push("--resume", sessionId);
  }

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: projectPath,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
}

// --- Log interaction ---

async function logInteraction(
  userId: number,
  prompt: string,
  sessionId: string,
  isNew: boolean,
  result: { stdout: string; stderr: string; exitCode: number }
): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `telegram-${userId}-${timestamp}.log`);

  const output = [
    `# telegram-${userId}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    result.stdout,
    ...(result.stderr ? ["## Stderr", result.stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
}

// --- Message handler ---

async function handleMessage(
  config: TelegramConfig,
  message: TelegramMessage
): Promise<void> {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text;

  // Only DMs
  if (message.chat.type !== "private") return;

  // Auth check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    await sendMessage(config.token, chatId, "Unauthorized.");
    return;
  }

  if (!text?.trim()) return;

  // /start command
  if (text.trim() === "/start") {
    await sendMessage(
      config.token,
      chatId,
      "Hello! Send me a message and I'll respond using Claude.\nUse /reset to start a fresh session."
    );
    return;
  }

  // /reset command
  if (text.trim() === "/reset") {
    await deleteSession(userId);
    await sendMessage(config.token, chatId, "Session cleared. Next message starts fresh.");
    return;
  }

  const { sessionId, isNew } = await getOrCreateSession(userId);
  const label = message.from.username ?? String(userId);
  console.log(`[${new Date().toLocaleTimeString()}] ${label}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}" (session: ${sessionId.slice(0, 8)}, ${isNew ? "new" : "resumed"})`);

  // Show typing indicator
  await sendTyping(config.token, chatId);

  try {
    const result = await runClaude(text, config.projectPath, sessionId, isNew);

    await logInteraction(userId, text, sessionId, isNew, result);

    if (result.exitCode !== 0) {
      await sendMessage(config.token, chatId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      await sendMessage(config.token, chatId, result.stdout || "(empty response)");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram] Error for ${label}: ${errMsg}`);
    await sendMessage(config.token, chatId, `Error: ${errMsg}`);
  }
}

// --- Polling loop ---

let running = true;

async function poll(config: TelegramConfig): Promise<void> {
  let offset = 0;

  console.log("Telegram bot started (long polling)");
  console.log(`  Project path: ${config.projectPath}`);
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);

  while (running) {
    try {
      const data = await callApi<{ ok: boolean; result: TelegramUpdate[] }>(
        config.token,
        "getUpdates",
        { offset, timeout: 30, allowed_updates: ["message"] }
      );

      if (!data.ok || !data.result.length) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          // Fire-and-forget so polling isn't blocked by slow Claude responses
          handleMessage(config, update.message).catch((err) => {
            console.error(`[Telegram] Unhandled: ${err}`);
          });
        }
      }
    } catch (err) {
      if (!running) break;
      console.error(`[Telegram] Poll error: ${err instanceof Error ? err.message : err}`);
      await Bun.sleep(5000);
    }
  }
}

// --- Main ---

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

async function main() {
  const config = await loadConfig();
  await poll(config);
}

main();
