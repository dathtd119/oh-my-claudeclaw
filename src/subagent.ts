/**
 * Stateless Haiku subagent runner for external data retrieval.
 * Used by main bot to fetch WhatsApp history or Obsidian notes without session persistence.
 */

export type SubagentTask = "whatsapp_read" | "obsidian_sync";

async function buildSubagentPrompt(task: SubagentTask, context: string): Promise<string> {
  if (task === "whatsapp_read") {
    return `[Subagent: WhatsApp Reader]
You are a data retrieval agent. Your job is to fetch recent WhatsApp history and extract relevant context.

User context: ${context}

Use the postsale-whatsapp-reader skill to:
1. Read recent WhatsApp chats (last 24h)
2. Find messages related to the user's request
3. Extract key information: sender, timestamp, message content, status
4. Format as JSON: { "messages": [{ "from": "", "time": "", "text": "" }], "summary": "" }

Return ONLY valid JSON output.`;
  }

  if (task === "obsidian_sync") {
    return `[Subagent: Obsidian Sync]
You are a data retrieval agent. Your job is to fetch PostSale notes from Obsidian.

User context: ${context}

Read from ~/claude/Bitel\ -\ Corp\ Architecture/ and ~/claude/Research/ directories:
1. Find PostSale, MINEDU, COAR, or project-related notes
2. Extract relevant sections matching the user's request
3. Return as JSON: { "notes": [{ "file": "", "section": "", "content": "" }], "summary": "" }

Return ONLY valid JSON output.`;
  }

  return "";
}

export async function runSubagent(
  task: SubagentTask,
  context: string
): Promise<string> {
  const prompt = await buildSubagentPrompt(task, context);

  try {
    // Unset CLAUDECODE to allow nested claude CLI call
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        prompt,
        "--model",
        "claude-haiku-4-5-20251001",
        "--max-turns",
        "3",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env,
      }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    if (proc.exitCode !== 0) {
      console.warn(`[subagent] ${task} failed (exit ${proc.exitCode}): ${stderr.slice(0, 100)}`);
      return "";
    }

    // Try to extract JSON from stdout
    try {
      const parsed = JSON.parse(stdout);
      const result = parsed.result ?? stdout;
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch {
      // If not valid JSON, return stdout as-is
      return stdout.slice(0, 500);
    }
  } catch (err) {
    console.warn(`[subagent] ${task} error:`, err instanceof Error ? err.message : err);
    return "";
  }
}
