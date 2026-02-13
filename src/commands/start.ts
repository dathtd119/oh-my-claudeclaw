import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { run, bootstrap } from "../runner";
import { writeState, type StateData } from "../statusline";
import { cronMatches, nextCronMatch } from "../cron";
import { loadJobs } from "../jobs";
import { writePidFile, cleanupPidFile, checkExistingDaemon } from "../pid";
import { initConfig, loadSettings, reloadSettings, resolvePrompt, type Settings } from "../config";
import type { Job } from "../jobs";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

// --- Statusline setup/teardown ---

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
const { readFileSync } = require("fs");
const { join } = require("path");

const DIR = join(__dirname, "claudeclaw");
const STATE_FILE = join(DIR, "state.json");
const PID_FILE = join(DIR, "daemon.pid");

const R = "\\x1b[0m";
const DIM = "\\x1b[2m";
const RED = "\\x1b[31m";
const GREEN = "\\x1b[32m";

function fmt(ms) {
  if (ms <= 0) return GREEN + "now!" + R;
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return (s % 60) + "s";
}

function alive() {
  try {
    var pid = readFileSync(PID_FILE, "utf-8").trim();
    process.kill(Number(pid), 0);
    return true;
  } catch { return false; }
}

var B = DIM + "\\u2502" + R;
var TL = DIM + "\\u256d" + R;
var TR = DIM + "\\u256e" + R;
var BL = DIM + "\\u2570" + R;
var BR = DIM + "\\u256f" + R;
var H = DIM + "\\u2500" + R;
var HEADER = TL + H.repeat(6) + " \\ud83e\\udd9e ClaudeClaw \\ud83e\\udd9e " + H.repeat(6) + TR;
var FOOTER = BL + H.repeat(30) + BR;

if (!alive()) {
  process.stdout.write(
    HEADER + "\\n" +
    B + "        " + RED + "\\u25cb offline" + R + "              " + B + "\\n" +
    FOOTER
  );
  process.exit(0);
}

try {
  var state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  var now = Date.now();
  var info = [];

  if (state.heartbeat) {
    info.push("\\ud83d\\udc93 " + fmt(state.heartbeat.nextAt - now));
  }

  var jc = (state.jobs || []).length;
  info.push("\\ud83d\\udccb " + jc + " job" + (jc !== 1 ? "s" : ""));
  info.push(GREEN + "\\u25cf live" + R);

  if (state.telegram) {
    info.push(GREEN + "\\ud83d\\udce1" + R);
  }

  var mid = " " + info.join(" " + B + " ") + " ";

  process.stdout.write(HEADER + "\\n" + B + mid + B + "\\n" + FOOTER);
} catch {
  process.stdout.write(
    HEADER + "\\n" +
    B + DIM + "         waiting...         " + R + B + "\\n" +
    FOOTER
  );
}
`;

async function setupStatusline() {
  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(STATUSLINE_FILE, STATUSLINE_SCRIPT);

  let settings: Record<string, unknown> = {};
  try {
    settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
  } catch {
    // file doesn't exist or isn't valid JSON
  }
  settings.statusLine = {
    type: "command",
    command: "node .claude/statusline.cjs",
  };
  await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

// --- Main ---

export async function start(args: string[] = []) {
  const hasPromptFlag = args.includes("--prompt");
  const hasTriggerFlag = args.includes("--trigger");
  const telegramFlag = args.includes("--telegram");
  const payload = args
    .filter((a) => a !== "--prompt" && a !== "--trigger" && a !== "--telegram")
    .join(" ")
    .trim();
  if (hasPromptFlag && !payload) {
    console.error("Usage: claudeclaw start --prompt <prompt> [--trigger] [--telegram]");
    process.exit(1);
  }
  if (!hasPromptFlag && payload) {
    console.error("Prompt text requires `--prompt`.");
    process.exit(1);
  }
  if (telegramFlag && !hasTriggerFlag) {
    console.error("`--telegram` with `start` requires `--trigger`.");
    process.exit(1);
  }

  // One-shot mode: explicit prompt without trigger.
  if (hasPromptFlag && !hasTriggerFlag) {
    const existingPid = await checkExistingDaemon();
    if (existingPid) {
      console.error(`\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`);
      console.error("Use `claudeclaw send <message> [--telegram]` while daemon is running.");
      process.exit(1);
    }

    await initConfig();
    await loadSettings();
    const result = await run("prompt", payload);
    console.log(result.stdout);
    if (result.exitCode !== 0) process.exit(result.exitCode);
    return;
  }

  const existingPid = await checkExistingDaemon();
  if (existingPid) {
    console.error(`\x1b[31mAborted: daemon already running in this directory (PID ${existingPid})\x1b[0m`);
    console.error(`Use --stop first, or kill PID ${existingPid} manually.`);
    process.exit(1);
  }

  await initConfig();
  const settings = await loadSettings();
  const jobs = await loadJobs();

  await setupStatusline();
  await writePidFile();

  async function shutdown() {
    await teardownStatusline();
    await cleanupPidFile();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("ClaudeClaw daemon started");
  console.log(`  PID: ${process.pid}`);
  console.log(`  Security: ${settings.security.level}`);
  if (settings.security.allowedTools.length > 0)
    console.log(`    + allowed: ${settings.security.allowedTools.join(", ")}`);
  if (settings.security.disallowedTools.length > 0)
    console.log(`    - blocked: ${settings.security.disallowedTools.join(", ")}`);
  console.log(`  Heartbeat: ${settings.heartbeat.enabled ? `every ${settings.heartbeat.interval}m` : "disabled"}`);
  console.log(`  Jobs loaded: ${jobs.length}`);
  jobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));

  // --- Mutable state ---
  let currentSettings: Settings = settings;
  let currentJobs: Job[] = jobs;
  let nextHeartbeatAt = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Telegram ---
  let telegramSend: ((chatId: number, text: string) => Promise<void>) | null = null;
  let telegramToken = "";

  async function initTelegram(token: string) {
    if (token && token !== telegramToken) {
      const { startPolling, sendMessage } = await import("./telegram");
      startPolling();
      telegramSend = (chatId, text) => sendMessage(token, chatId, text);
      telegramToken = token;
      console.log(`[${ts()}] Telegram: enabled`);
    } else if (!token && telegramToken) {
      telegramSend = null;
      telegramToken = "";
      console.log(`[${ts()}] Telegram: disabled`);
    }
  }

  await initTelegram(currentSettings.telegram.token);
  if (!telegramToken) console.log("  Telegram: not configured");

  // --- Helpers ---
  function ts() { return new Date().toLocaleTimeString(); }

  function forwardToTelegram(label: string, result: { exitCode: number; stdout: string; stderr: string }) {
    if (!telegramSend || currentSettings.telegram.allowedUserIds.length === 0) return;
    const text = result.exitCode === 0
      ? `${label ? `[${label}]\n` : ""}${result.stdout || "(empty)"}`
      : `${label ? `[${label}] ` : ""}error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;
    for (const userId of currentSettings.telegram.allowedUserIds) {
      telegramSend(userId, text).catch((err) =>
        console.error(`[Telegram] Failed to forward to ${userId}: ${err}`)
      );
    }
  }

  // --- Heartbeat scheduling ---
  function scheduleHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    if (!currentSettings.heartbeat.enabled || !currentSettings.heartbeat.prompt) {
      nextHeartbeatAt = 0;
      return;
    }

    const ms = currentSettings.heartbeat.interval * 60_000;
    nextHeartbeatAt = 0;

    function tick() {
      resolvePrompt(currentSettings.heartbeat.prompt)
        .then((prompt) => run("heartbeat", prompt))
        .then((r) => forwardToTelegram("", r));
      nextHeartbeatAt = Date.now() + ms;
    }

    tick();
    heartbeatTimer = setInterval(tick, ms);
  }

  // Startup init:
  // - trigger mode: run exactly one trigger prompt (no separate bootstrap)
  // - normal mode: bootstrap to initialize session context
  if (hasTriggerFlag) {
    const triggerPrompt = hasPromptFlag ? payload : "Wake up, my friend!";
    const triggerResult = await run("trigger", triggerPrompt);
    console.log(triggerResult.stdout);
    if (telegramFlag) forwardToTelegram("", triggerResult);
    if (triggerResult.exitCode !== 0) {
      console.error(`[${ts()}] Startup trigger failed (exit ${triggerResult.exitCode}). Daemon will continue running.`);
    }
  } else {
    // Bootstrap the session first so system prompt is initial context
    // and session.json is created immediately.
    await bootstrap();
  }

  if (currentSettings.heartbeat.enabled) scheduleHeartbeat();

  // --- Hot-reload loop (every 30s) ---
  setInterval(async () => {
    try {
      const newSettings = await reloadSettings();
      const newJobs = await loadJobs();

      // Detect heartbeat config changes
      const hbChanged =
        newSettings.heartbeat.enabled !== currentSettings.heartbeat.enabled ||
        newSettings.heartbeat.interval !== currentSettings.heartbeat.interval ||
        newSettings.heartbeat.prompt !== currentSettings.heartbeat.prompt;

      // Detect security config changes
      const secChanged =
        newSettings.security.level !== currentSettings.security.level ||
        newSettings.security.allowedTools.join(",") !== currentSettings.security.allowedTools.join(",") ||
        newSettings.security.disallowedTools.join(",") !== currentSettings.security.disallowedTools.join(",");

      if (secChanged) {
        console.log(`[${ts()}] Security level changed → ${newSettings.security.level}`);
      }

      if (hbChanged) {
        console.log(`[${ts()}] Config change detected — heartbeat: ${newSettings.heartbeat.enabled ? `every ${newSettings.heartbeat.interval}m` : "disabled"}`);
        currentSettings = newSettings;
        scheduleHeartbeat();
      } else {
        currentSettings = newSettings;
      }

      // Detect job changes
      const jobNames = newJobs.map((j) => `${j.name}:${j.schedule}:${j.prompt}`).sort().join("|");
      const oldJobNames = currentJobs.map((j) => `${j.name}:${j.schedule}:${j.prompt}`).sort().join("|");
      if (jobNames !== oldJobNames) {
        console.log(`[${ts()}] Jobs reloaded: ${newJobs.length} job(s)`);
        newJobs.forEach((j) => console.log(`    - ${j.name} [${j.schedule}]`));
      }
      currentJobs = newJobs;

      // Telegram changes
      await initTelegram(newSettings.telegram.token);
    } catch (err) {
      console.error(`[${ts()}] Hot-reload error:`, err);
    }
  }, 30_000);

  // --- Cron tick (every 60s) ---
  const daemonStartedAt = Date.now();

  function updateState() {
    const now = new Date();
    const state: StateData = {
      heartbeat: currentSettings.heartbeat.enabled
        ? { nextAt: nextHeartbeatAt }
        : undefined,
      jobs: currentJobs.map((job) => ({
        name: job.name,
        nextAt: nextCronMatch(job.schedule, now).getTime(),
      })),
      security: currentSettings.security.level,
      telegram: !!currentSettings.telegram.token,
      startedAt: daemonStartedAt,
    };
    writeState(state);
  }

  updateState();

  setInterval(() => {
    const now = new Date();
    for (const job of currentJobs) {
      if (cronMatches(job.schedule, now)) {
        resolvePrompt(job.prompt)
          .then((prompt) => run(job.name, prompt))
          .then((r) => forwardToTelegram(job.name, r));
      }
    }
    updateState();
  }, 60_000);
}
