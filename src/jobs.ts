import { readdir } from "fs/promises";
import { join } from "path";

const JOBS_DIR = join(process.cwd(), ".claude", "claudeclaw", "jobs");

export interface Job {
  name: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  notify: true | false | "error";
  // oh-my-claudeclaw extensions
  sessionGroup?: string;
  model?: string;
  tools?: string;
  settingSources?: string;
  effort?: string;
  maxTurns?: number;
  type?: "maintenance";
  command?: string;
}

function parseFrontmatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function parseJobFile(name: string, content: string): Job | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    console.error(`Invalid job file format: ${name}`);
    return null;
  }

  const frontmatter = match[1];
  const prompt = match[2].trim();
  const lines = frontmatter.split("\n").map((l) => l.trim());

  const get = (key: string): string | undefined => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line ? parseFrontmatterValue(line.slice(key.length + 1)) : undefined;
  };

  const schedule = get("schedule");
  if (!schedule) return null;

  const recurringRaw = (get("recurring") ?? get("daily") ?? "").toLowerCase();
  const recurring = recurringRaw === "true" || recurringRaw === "yes" || recurringRaw === "1";

  const notifyRaw = (get("notify") ?? "").toLowerCase();
  const notify: true | false | "error" =
    notifyRaw === "false" || notifyRaw === "no" ? false
    : notifyRaw === "error" ? "error"
    : true;

  const job: Job = { name, schedule, prompt, recurring, notify };

  const sessionGroup = get("session_group") ?? get("sessionGroup");
  if (sessionGroup) job.sessionGroup = sessionGroup;

  const model = get("model");
  if (model) job.model = model;

  const tools = get("tools");
  if (tools) job.tools = tools;

  const settingSources = get("setting_sources") ?? get("settingSources");
  if (settingSources) job.settingSources = settingSources;

  const effort = get("effort");
  if (effort) job.effort = effort;

  const maxTurns = get("max_turns") ?? get("maxTurns");
  if (maxTurns) {
    const n = Number(maxTurns);
    if (Number.isFinite(n) && n > 0) job.maxTurns = n;
  }

  const type = get("type");
  if (type === "maintenance") job.type = "maintenance";

  const command = get("command");
  if (command) job.command = command;

  return job;
}

export async function loadJobs(): Promise<Job[]> {
  const jobs: Job[] = [];
  let files: string[];
  try {
    files = await readdir(JOBS_DIR);
  } catch {
    return jobs;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const content = await Bun.file(join(JOBS_DIR, file)).text();
    const job = parseJobFile(file.replace(/\.md$/, ""), content);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function clearJobSchedule(jobName: string): Promise<void> {
  const path = join(JOBS_DIR, `${jobName}.md`);
  const content = await Bun.file(path).text();
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return;

  const filteredFrontmatter = match[1]
    .split("\n")
    .filter((line) => !line.trim().startsWith("schedule:"))
    .join("\n")
    .trim();

  const body = match[2].trim();
  const next = `---\n${filteredFrontmatter}\n---\n${body}\n`;
  await Bun.write(path, next);
}
