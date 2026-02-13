---
name: status
description: Show full dashboard of the claudeclaw daemon — process status, heartbeat details, cron jobs, countdowns, and recent logs. Use when users ask "status", "how many jobs", "what's running", "show details", "dashboard", "overview", "am I running", "is the daemon alive", "what jobs do I have", "show heartbeat info", "show logs", "recent activity", "what happened", "last run".
---

# Status Skill

Show a full dashboard of the claudeclaw daemon. Gather all info and present it clearly.

## Steps

### 1. Daemon Process

- Read `.claude/claudeclaw/daemon.pid` and check if the process is alive with `kill -0 <pid>`.
- Report: **Running** or **Stopped**.

### 2. Heartbeat Details

- Read `.claude/claudeclaw/settings.json`.
- Show:
  - **Enabled**: yes/no
  - **Interval**: X minutes
  - **Prompt**: the full prompt or "not set"

### 3. Cron Jobs

- List all `.md` files in `.claude/claudeclaw/jobs/`.
- For each job show:
  - **Name** (filename without `.md`)
  - **Schedule** (cron expression from frontmatter)
  - **Prompt** (body text, truncated to 80 chars)
- Show total count: **X jobs configured**
- If no jobs exist, say "No cron jobs configured."

### 4. Countdowns

- Read `.claude/claudeclaw/state.json`.
- For the heartbeat and each job, calculate and show time remaining until next run based on current time.
- If state data is missing, say "No run history yet."

### 5. Telegram

- From settings, show:
  - **Token**: first 5 chars + "..." or "not configured"
  - **Allowed users**: list IDs or "none"

### 6. Recent Logs

- List files in `.claude/claudeclaw/logs/` sorted by modification time (newest first).
- Show the **3 most recent** logs with:
  - Log name
  - Timestamp
  - First 3 lines of output (truncated preview)
- If no logs exist, say "No logs yet."

## Output Format

Present everything as a clean dashboard:

```
== CLAUDECLAW STATUS ==

Daemon:     Running (PID 12345)
Uptime:     since 2025-01-15 09:00

-- Heartbeat --
Enabled:    yes
Interval:   15m
Prompt:     "Check git status..."
Next run:   in 8m 32s

-- Cron Jobs (2) --
 git-summary   | 0 9 * * *   | "Summarize yesterday's commits..."
 test-runner   | 0 */6 * * * | "Run the test suite and report..."

-- Telegram --
Token:      abc12...
Users:      [123456789]

-- Recent Activity --
 heartbeat-2025-01-15T09-15-00  | success
 git-summary-2025-01-15T09-00   | success
 heartbeat-2025-01-15T09-00-00  | success
```
