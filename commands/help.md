---
description: Show ClaudeClaw plugin help
---

Display this help information to the user:

**ClaudeClaw** — daemon mode with cron job scheduling (heartbeat disabled as of 2026-02-28).

**Commands:**
- `/heartbeat:start` — Initialize config and start the daemon
- `/heartbeat:stop` — Stop the running daemon
- `/heartbeat:clear` — Back up the current session and restart fresh
- `/heartbeat:status` — Show daemon status, countdowns, and config
- `/heartbeat:config` — View or modify heartbeat settings (interval, prompt, telegram)
- `/heartbeat:jobs` — Create, list, edit, or delete cron jobs
- `/heartbeat:logs` — Show recent execution logs (accepts count or job name filter)
- `/heartbeat:telegram` — Show Telegram bot status and sessions (use `clear` to reset sessions)
- `/heartbeat:help` — Show this help message

**Start command options (CLI):**
- `bun run src/index.ts start` — normal daemon mode
- `bun run src/index.ts start --prompt "text"` — one-shot prompt, no daemon loop
- `bun run src/index.ts start --trigger` — start daemon and run startup trigger once
- `bun run src/index.ts start --prompt "text" --trigger` — start daemon and run startup trigger with custom prompt
- Add `--telegram` with `--trigger` to forward startup trigger output to configured Telegram users
- Add `--web` (optional `--web-port 4632`) to start a local dashboard with the daemon

**Send command options (CLI):**
- `bun run src/index.ts send "text"` — send to active daemon session
- `bun run src/index.ts send "text" --telegram` — send and forward output to Telegram
- If daemon is already running, use `send`; `start` will abort.

**How it works:**
- The daemon runs in the background checking your schedule every 60 seconds
- **Jobs** are markdown files in `.claude/claudeclaw/jobs/` with cron schedules (timezone-aware, evaluated in configured `timezone`)
- Each job runs when its cron schedule matches; all periodic work is job-based (no separate heartbeat)
- The statusline shows job status and next execution times

**Configuration:**
- `.claude/claudeclaw/settings.json` — Main config (telegram, security, web). Heartbeat disabled.
- `.claude/claudeclaw/jobs/*.md` — Cron jobs with schedule frontmatter and a prompt body
- `.claude/claudeclaw/jobs/*.md` — Cron jobs with schedule frontmatter and a prompt body

**Job file format:**
```markdown
---
schedule: "0 9 * * *"
---
Your prompt here. Claude will run this at the scheduled time.
```

Schedule uses standard cron syntax: `minute hour day-of-month month day-of-week`

**Note:** Bun is required to run the daemon. It will be auto-installed on first `/heartbeat:start` if missing.

**Telegram:**
- Configure in `.claude/claudeclaw/settings.json` under `telegram`
- Daemon mode can run Telegram polling in-process when token is configured
- Startup trigger `start --trigger --telegram` and daemon `send --telegram` can forward responses
