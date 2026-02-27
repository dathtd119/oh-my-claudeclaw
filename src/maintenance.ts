import { execClaude } from "./runner";

export interface MaintenanceJob {
  name: string;
  command: string;
  notify: boolean;
}

/**
 * Run a maintenance command via shell, then check output for errors.
 * If errors found and notify=true, spawn haiku to triage and return summary.
 */
export async function runMaintenance(job: MaintenanceJob): Promise<{ ok: boolean; output: string; triage?: string }> {
  const proc = Bun.spawn(["bash", "-c", job.command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const combined = `${stdout}\n${stderr}`.trim();

  const hasError = exitCode !== 0 || /\b(ERROR|FATAL|FAIL|CRITICAL)\b/i.test(combined);

  if (!hasError) return { ok: true, output: combined };

  if (!job.notify) return { ok: false, output: combined };

  const triagePrompt = [
    `Maintenance job "${job.name}" failed (exit ${exitCode}).`,
    "Output (last 2000 chars):",
    "```",
    combined.slice(-2000),
    "```",
    "Summarize the error in 2-3 sentences. What likely went wrong and what to check.",
  ].join("\n");

  try {
    const triage = await execClaude(`triage-${job.name}`, triagePrompt, {
      model: "haiku",
      noSessionPersistence: true,
      tools: "",
      effort: "low",
      maxTurns: 1,
    });
    return { ok: false, output: combined, triage: triage.stdout.trim() || "No triage output." };
  } catch {
    return { ok: false, output: combined, triage: "Triage failed — check output manually." };
  }
}
