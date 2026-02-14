import { join } from "path";
import { readFile, readdir, stat } from "fs/promises";
import type { Job } from "./jobs";
import type { Settings } from "./config";
import { peekSession } from "./sessions";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

export interface WebSnapshot {
  pid: number;
  startedAt: number;
  heartbeatNextAt: number;
  settings: Settings;
  jobs: Job[];
}

export interface WebServerHandle {
  stop: () => void;
  host: string;
  port: number;
}

export function startWebUi(opts: {
  host: string;
  port: number;
  getSnapshot: () => WebSnapshot;
}): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now() });
      }

      if (url.pathname === "/api/state") {
        return json(await buildState(opts.getSnapshot()));
      }

      if (url.pathname === "/api/settings") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/jobs") {
        const jobs = opts.getSnapshot().jobs.map((j) => ({
          name: j.name,
          schedule: j.schedule,
          promptPreview: j.prompt.slice(0, 160),
        }));
        return json({ jobs });
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(),
    host: opts.host,
    port: server.port,
  };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function sanitizeSettings(settings: Settings) {
  return {
    heartbeat: settings.heartbeat,
    security: settings.security,
    telegram: {
      configured: Boolean(settings.telegram.token),
      allowedUserCount: settings.telegram.allowedUserIds.length,
    },
    web: settings.web,
  };
}

async function buildState(snapshot: WebSnapshot) {
  const now = Date.now();
  const session = await peekSession();
  return {
    daemon: {
      running: true,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: now - snapshot.startedAt,
    },
    heartbeat: {
      enabled: snapshot.settings.heartbeat.enabled,
      intervalMinutes: snapshot.settings.heartbeat.interval,
      nextAt: snapshot.heartbeatNextAt || null,
      nextInMs: snapshot.heartbeatNextAt ? Math.max(0, snapshot.heartbeatNextAt - now) : null,
    },
    jobs: snapshot.jobs.map((j) => ({ name: j.name, schedule: j.schedule })),
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    session: session
      ? {
          sessionIdShort: session.sessionId.slice(0, 8),
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
    web: snapshot.settings.web,
  };
}

async function readLogs(tail: number) {
  const daemonLog = await readTail(join(LOGS_DIR, "daemon.log"), tail);
  const runs = await readRecentRunLogs(tail);
  return { daemonLog, runs };
}

async function readRecentRunLogs(tail: number) {
  let files: string[] = [];
  try {
    files = await readdir(LOGS_DIR);
  } catch {
    return [];
  }

  const candidates = files
    .filter((f) => f.endsWith(".log") && f !== "daemon.log")
    .slice(0, 200);

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      const path = join(LOGS_DIR, name);
      try {
        const s = await stat(path);
        return { name, path, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    })
  );

  return await Promise.all(
    withStats
      .filter((x): x is { name: string; path: string; mtime: number } => Boolean(x))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5)
      .map(async ({ name, path }) => ({
        file: name,
        lines: await readTail(path, tail),
      }))
  );
}

async function readTail(path: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(path, "utf-8");
    const all = text.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).filter(Boolean);
  } catch {
    return [];
  }
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeClaw Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800&family=JetBrains+Mono:wght@400;500;700&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d13;
      --surface: #0f1419;
      --card: #141b22;
      --card-hover: #19222c;
      --border: #1e2a36;
      --border-glow: #1a3a4a;
      --text: #e2e8f0;
      --text-dim: #6b7b8d;
      --text-muted: #3d4f5f;
      --mint: #00e5a0;
      --mint-dim: #00e5a022;
      --mint-glow: #00e5a015;
      --amber: #f0883e;
      --amber-dim: #f0883e22;
      --purple: #a78bfa;
      --purple-dim: #a78bfa22;
      --cyan: #22d3ee;
      --red: #f85149;
      --red-dim: #f8514922;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Ambient background glow */
    body::before {
      content: '';
      position: fixed;
      top: -40%;
      left: -20%;
      width: 80%;
      height: 80%;
      background: radial-gradient(ellipse, #00e5a008 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }
    body::after {
      content: '';
      position: fixed;
      bottom: -30%;
      right: -10%;
      width: 60%;
      height: 60%;
      background: radial-gradient(ellipse, #a78bfa06 0%, transparent 60%);
      pointer-events: none;
      z-index: 0;
    }

    .shell {
      position: relative;
      z-index: 1;
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* ── Header ── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .logo {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--mint), #00b87a);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      color: var(--bg);
      font-family: 'Unbounded', sans-serif;
      box-shadow: 0 0 24px #00e5a025, 0 0 48px #00e5a010;
    }
    .brand-text h1 {
      font-family: 'Unbounded', sans-serif;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .brand-text .tagline {
      font-size: 12px;
      color: var(--text-dim);
      margin-top: 2px;
      font-family: 'JetBrains Mono', monospace;
    }
    .header-meta {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }
    .live-dot {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .live-dot::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--mint);
      box-shadow: 0 0 8px var(--mint), 0 0 16px #00e5a040;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--mint), 0 0 16px #00e5a040; }
      50% { opacity: 0.5; box-shadow: 0 0 4px var(--mint), 0 0 8px #00e5a020; }
    }
    .updated-at {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
    }

    /* ── Status Strip ── */
    .status-strip {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
      padding: 12px 16px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow-x: auto;
    }
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 500;
      white-space: nowrap;
      background: var(--mint-dim);
      color: var(--mint);
      border: 1px solid #00e5a018;
    }
    .status-chip.warn {
      background: var(--amber-dim);
      color: var(--amber);
      border-color: #f0883e18;
    }
    .status-chip.info {
      background: var(--purple-dim);
      color: var(--purple);
      border-color: #a78bfa18;
    }
    .status-chip.off {
      background: var(--red-dim);
      color: var(--red);
      border-color: #f8514918;
    }
    .chip-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    /* ── Cards Grid ── */
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 24px;
    }
    @media (max-width: 800px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 520px) {
      .grid { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
      transition: all 0.25s ease;
      position: relative;
      overflow: hidden;
      opacity: 0;
      transform: translateY(12px);
      animation: cardIn 0.4s ease forwards;
    }
    .card:nth-child(1) { animation-delay: 0.05s; }
    .card:nth-child(2) { animation-delay: 0.1s; }
    .card:nth-child(3) { animation-delay: 0.15s; }
    .card:nth-child(4) { animation-delay: 0.2s; }
    .card:nth-child(5) { animation-delay: 0.25s; }
    .card:nth-child(6) { animation-delay: 0.3s; }
    @keyframes cardIn {
      to { opacity: 1; transform: translateY(0); }
    }
    .card:hover {
      background: var(--card-hover);
      border-color: var(--border-glow);
      box-shadow: 0 4px 24px #00000030;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--mint), transparent);
      opacity: 0;
      transition: opacity 0.25s;
    }
    .card:hover::before { opacity: 0.6; }

    .card-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      margin-bottom: 14px;
    }
    .card-icon.green { background: var(--mint-dim); color: var(--mint); }
    .card-icon.amber { background: var(--amber-dim); color: var(--amber); }
    .card-icon.purple { background: var(--purple-dim); color: var(--purple); }
    .card-icon.cyan { background: #22d3ee18; color: var(--cyan); }

    .card-label {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-dim);
      margin-bottom: 8px;
    }
    .card-value {
      font-family: 'Unbounded', sans-serif;
      font-weight: 600;
      font-size: 20px;
      line-height: 1.2;
      margin-bottom: 4px;
    }
    .card-sub {
      font-size: 13px;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    /* ── Log Terminal ── */
    .terminal {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      opacity: 0;
      transform: translateY(12px);
      animation: cardIn 0.4s ease 0.35s forwards;
    }
    .terminal-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: var(--card);
      border-bottom: 1px solid var(--border);
    }
    .terminal-dots {
      display: flex;
      gap: 6px;
    }
    .terminal-dots span {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--text-muted);
      opacity: 0.5;
    }
    .terminal-dots span:first-child { background: #f85149; opacity: 0.8; }
    .terminal-dots span:nth-child(2) { background: #f0883e; opacity: 0.8; }
    .terminal-dots span:last-child { background: var(--mint); opacity: 0.8; }
    .terminal-title {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .terminal-body {
      padding: 16px;
      max-height: 400px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.7;
      color: #8b9eb0;
      white-space: pre;
      tab-size: 2;
    }
    .terminal-body::-webkit-scrollbar { width: 6px; }
    .terminal-body::-webkit-scrollbar-track { background: transparent; }
    .terminal-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .terminal-body::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

    .log-line { display: block; padding: 1px 0; }
    .log-ts { color: var(--text-muted); }
    .log-err { color: var(--red); }
    .log-warn { color: var(--amber); }
    .log-ok { color: var(--mint); }
    .log-file { color: var(--cyan); font-weight: 500; }

    /* ── Heartbeat Progress ── */
    .hb-bar-wrap {
      margin-top: 10px;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
    }
    .hb-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--mint), #00b87a);
      border-radius: 2px;
      transition: width 1s linear;
      box-shadow: 0 0 8px #00e5a030;
    }
  </style>
</head>
<body>
  <div class="shell">
    <!-- Header -->
    <div class="header">
      <div class="brand">
        <div class="logo">C</div>
        <div class="brand-text">
          <h1>ClaudeClaw</h1>
          <div class="tagline" id="uptime">initializing...</div>
        </div>
      </div>
      <div class="header-meta">
        <div class="live-dot" id="live-label">live</div>
        <div class="updated-at" id="updated">--:--:--</div>
      </div>
    </div>

    <!-- Status Strip -->
    <div class="status-strip" id="status-strip">
      <div class="status-chip"><span class="chip-dot"></span> loading...</div>
    </div>

    <!-- Cards -->
    <div class="grid">
      <div class="card" id="card-daemon">
        <div class="card-icon green">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <div class="card-label">Daemon</div>
        <div class="card-value" id="daemon-val">--</div>
        <div class="card-sub" id="daemon-sub">&nbsp;</div>
      </div>

      <div class="card" id="card-heartbeat">
        <div class="card-icon amber">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 14s-5.5-3.5-5.5-7A3.5 3.5 0 0 1 8 4.5 3.5 3.5 0 0 1 13.5 7C13.5 10.5 8 14 8 14z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </div>
        <div class="card-label">Heartbeat</div>
        <div class="card-value" id="hb-val">--</div>
        <div class="card-sub" id="hb-sub">&nbsp;</div>
        <div class="hb-bar-wrap"><div class="hb-bar" id="hb-bar" style="width:0%"></div></div>
      </div>

      <div class="card" id="card-jobs">
        <div class="card-icon purple">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 1v4M11 1v4M2 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <div class="card-label">Cron Jobs</div>
        <div class="card-value" id="jobs-val">--</div>
        <div class="card-sub" id="jobs-sub">&nbsp;</div>
      </div>

      <div class="card" id="card-security">
        <div class="card-icon cyan">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </div>
        <div class="card-label">Security</div>
        <div class="card-value" id="sec-val">--</div>
        <div class="card-sub" id="sec-sub">&nbsp;</div>
      </div>

      <div class="card" id="card-telegram">
        <div class="card-icon purple">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 2L7 9M14 2l-4 12-3-5.5L2 6l12-4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </div>
        <div class="card-label">Telegram</div>
        <div class="card-value" id="tg-val">--</div>
        <div class="card-sub" id="tg-sub">&nbsp;</div>
      </div>

      <div class="card" id="card-session">
        <div class="card-icon green">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 7l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="card-label">Session</div>
        <div class="card-value" id="sess-val">--</div>
        <div class="card-sub" id="sess-sub">&nbsp;</div>
      </div>
    </div>

    <!-- Log Terminal -->
    <div class="terminal">
      <div class="terminal-bar">
        <div class="terminal-dots"><span></span><span></span><span></span></div>
        <div class="terminal-title">daemon logs</div>
        <div style="width:50px"></div>
      </div>
      <div class="terminal-body" id="logs">Connecting...</div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const fmtDur = (ms) => {
      if (ms == null) return "n/a";
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      if (h > 0) return h + "h " + m + "m " + ss + "s";
      if (m > 0) return m + "m " + ss + "s";
      return ss + "s";
    };

    const secColors = { locked: "red", strict: "amber", moderate: "cyan", unrestricted: "warn" };

    function colorLog(line) {
      if (line.startsWith("== ")) return '<span class="log-file">' + esc(line) + '</span>';
      if (/error|fail|exception/i.test(line)) return '<span class="log-err">' + esc(line) + '</span>';
      if (/warn/i.test(line)) return '<span class="log-warn">' + esc(line) + '</span>';
      if (/started|success|enabled|connected/i.test(line)) return '<span class="log-ok">' + esc(line) + '</span>';
      // dim timestamps at start of lines
      const tsMatch = line.match(/^(\\[.*?\\])(.*)/);
      if (tsMatch) return '<span class="log-ts">' + esc(tsMatch[1]) + '</span>' + esc(tsMatch[2]);
      return esc(line);
    }
    function esc(s) {
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    async function tick() {
      try {
        const [stateRes, logsRes] = await Promise.all([
          fetch("/api/state"),
          fetch("/api/logs?tail=80"),
        ]);
        const state = await stateRes.json();
        const logs = await logsRes.json();

        // Uptime
        $("uptime").textContent = "pid " + state.daemon.pid + " \\u00b7 up " + fmtDur(state.daemon.uptimeMs);

        // Status strip
        const chips = [];
        chips.push({ label: "daemon running", cls: "" });
        chips.push({ label: "security: " + state.security.level, cls: state.security.level === "moderate" ? "info" : "warn" });
        if (state.heartbeat.enabled) chips.push({ label: "heartbeat: " + state.heartbeat.intervalMinutes + "m", cls: "" });
        else chips.push({ label: "heartbeat off", cls: "off" });
        if (state.telegram.configured) chips.push({ label: "telegram: " + state.telegram.allowedUserCount + " user" + (state.telegram.allowedUserCount !== 1 ? "s" : ""), cls: "info" });
        else chips.push({ label: "telegram off", cls: "off" });
        if (state.session) chips.push({ label: "session: " + state.session.sessionIdShort, cls: "" });
        $("status-strip").innerHTML = chips.map(c =>
          '<div class="status-chip ' + c.cls + '"><span class="chip-dot"></span> ' + c.label + '</div>'
        ).join("");

        // Daemon card
        $("daemon-val").innerHTML = '<span style="color:var(--mint)">Running</span>';
        $("daemon-sub").textContent = "PID " + state.daemon.pid + " \\u00b7 " + fmtDur(state.daemon.uptimeMs);

        // Heartbeat card
        if (state.heartbeat.enabled) {
          const nextIn = fmtDur(state.heartbeat.nextInMs);
          $("hb-val").textContent = "Every " + state.heartbeat.intervalMinutes + "m";
          $("hb-sub").textContent = "next in " + nextIn;
          const totalMs = state.heartbeat.intervalMinutes * 60 * 1000;
          const elapsed = totalMs - (state.heartbeat.nextInMs || 0);
          const pct = Math.min(100, Math.max(0, (elapsed / totalMs) * 100));
          $("hb-bar").style.width = pct + "%";
        } else {
          $("hb-val").innerHTML = '<span style="color:var(--text-dim)">Disabled</span>';
          $("hb-sub").textContent = "no schedule";
          $("hb-bar").style.width = "0%";
        }

        // Jobs card
        const jc = state.jobs.length;
        $("jobs-val").textContent = jc;
        $("jobs-sub").textContent = jc === 0 ? "no cron jobs" : state.jobs.map(j => j.name).join(", ");

        // Security card
        $("sec-val").textContent = state.security.level;
        const secDesc = {
          locked: "All tools blocked",
          strict: "Allowlist only",
          moderate: "Standard protection",
          unrestricted: "No restrictions",
        };
        $("sec-sub").textContent = secDesc[state.security.level] || "";

        // Telegram card
        if (state.telegram.configured) {
          $("tg-val").innerHTML = '<span style="color:var(--mint)">Active</span>';
          $("tg-sub").textContent = state.telegram.allowedUserCount + " authorized user" + (state.telegram.allowedUserCount !== 1 ? "s" : "");
        } else {
          $("tg-val").innerHTML = '<span style="color:var(--text-dim)">Inactive</span>';
          $("tg-sub").textContent = "not configured";
        }

        // Session card
        if (state.session) {
          $("sess-val").textContent = state.session.sessionIdShort + "...";
          const created = new Date(state.session.createdAt);
          $("sess-sub").textContent = "since " + created.toLocaleTimeString();
        } else {
          $("sess-val").innerHTML = '<span style="color:var(--text-dim)">None</span>';
          $("sess-sub").textContent = "no active session";
        }

        // Logs
        const daemonLines = (logs.daemonLog || []).slice(-40);
        const runLines = [];
        for (const run of (logs.runs || [])) {
          runLines.push("== " + run.file + " ==");
          runLines.push(...(run.lines || []).slice(-20));
        }
        const allLines = [...daemonLines, ...runLines];
        const logEl = $("logs");
        const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
        logEl.innerHTML = allLines.map(l => '<span class="log-line">' + colorLog(l) + '</span>').join("\\n") || '<span style="color:var(--text-muted)">(no logs yet)</span>';
        if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;

        $("updated").textContent = new Date().toLocaleTimeString();
        $("live-label").textContent = "live";

      } catch (e) {
        $("live-label").textContent = "offline";
        $("logs").textContent = "Connection error: " + String(e);
      }
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>`;
}
