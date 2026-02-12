---
description: Show Telegram bot status and manage sessions
---

Show the Telegram bot integration status. Check the following:

1. **Configuration**: Read `.claude/heartbeat/settings.json` and check if `telegram.token` is set (show masked token: first 5 chars + "..."). Show `projectPath` and `allowedUserIds`.

2. **Sessions**: Read `.claude/heartbeat/telegram-sessions.json` and list active sessions showing:
   - User ID
   - Session UUID (first 8 chars)
   - Created at
   - Last message at

3. **If $ARGUMENTS contains "clear"**: Delete `.claude/heartbeat/telegram-sessions.json` to reset all sessions. Confirm to the user.

4. **Running**: Check if the Telegram bot process is running by looking for `bun` processes with `telegram.ts`. If `which bun` fails (Bun not installed), tell the user to run `/heartbeat:start` first, which will auto-install Bun.

Format the output clearly for the user.
