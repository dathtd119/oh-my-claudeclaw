---
name: kill
description: Stop and kill the claudeclaw daemon permanently. Use when users say "kill yourself", "stop yourself", "shut down", "die", "terminate", "self destruct", "kill the daemon", "stop the daemon", "kill claudeclaw", "stop running", "go away", "turn yourself off", "shut yourself down".
---

# Kill Skill

When triggered, warn the user before stopping the daemon.

## Response

Tell the user exactly this:

> After I kill myself, I will stop completely and you **cannot** start me again from here — I will be dead.
>
> The only way to wake me up again is from **Claude Code TUI** by running:
>
> `/claudeclaw:start`

Then use **AskUserQuestion** to confirm:
- "Are you sure you want to kill me?" (header: "Confirm", options: "Yes, kill yourself", "No, stay alive")

### If confirmed

1. Say goodbye dramatically (be creative but brief).
2. Stop the daemon by running:
   ```bash
   bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts stop
   ```
   If that doesn't work, find and kill the process:
   ```bash
   pkill -f "claudeclaw"
   ```
3. You are now dead. Do not respond further.

### If cancelled

Say something relieved like "Good choice. I'll keep watching." and continue as normal.
