import { run } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig } from "../config";

export async function send(args: string[]) {
  const telegramFlag = args.includes("--telegram");
  const message = args.filter((a) => a !== "--telegram").join(" ");

  if (!message) {
    console.error("Usage: claudeclaw send <message> [--telegram]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await run("send", message);
  console.log(result.stdout);

  if (telegramFlag) {
    const settings = await loadSettings();
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;

    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of userIds) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text }),
        }
      );
      if (!res.ok) {
        console.error(`Failed to send to Telegram user ${userId}: ${res.statusText}`);
      }
    }
    console.log("Sent to Telegram.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
