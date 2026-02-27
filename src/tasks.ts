import { join } from "path";
import { existsSync } from "fs";

const TASKS_FILE = join(process.cwd(), ".claude", "claudeclaw", "tasks.json");

export interface Task {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: string;
}

async function readTasks(): Promise<Task[]> {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return await Bun.file(TASKS_FILE).json();
  } catch {
    return [];
  }
}

async function writeTasks(tasks: Task[]): Promise<void> {
  const tmp = TASKS_FILE + ".tmp";
  await Bun.write(tmp, JSON.stringify(tasks, null, 2) + "\n");
  const fs = await import("fs/promises");
  await fs.rename(tmp, TASKS_FILE);
}

export async function createTask(description: string): Promise<Task> {
  const tasks = await readTasks();
  const task: Task = {
    id: crypto.randomUUID().slice(0, 8),
    description,
    status: "pending",
    createdAt: Date.now(),
  };
  tasks.push(task);
  await writeTasks(tasks);
  return task;
}

export async function listTasks(): Promise<Task[]> {
  return readTasks();
}

export async function updateTask(id: string, patch: Partial<Pick<Task, "status" | "result">>): Promise<Task | null> {
  const tasks = await readTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  if (patch.status) task.status = patch.status;
  if (patch.result !== undefined) task.result = patch.result;
  if (task.status === "completed" || task.status === "failed") {
    task.completedAt = Date.now();
  }
  await writeTasks(tasks);
  return task;
}

export async function deleteTask(id: string): Promise<boolean> {
  const tasks = await readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  await writeTasks(tasks);
  return true;
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupOldTasks(maxAge = SEVEN_DAYS): Promise<number> {
  const tasks = await readTasks();
  const now = Date.now();
  const kept = tasks.filter((t) => {
    if (t.status !== "completed" && t.status !== "failed") return true;
    return (t.completedAt ?? t.createdAt) + maxAge > now;
  });
  const removed = tasks.length - kept.length;
  if (removed > 0) await writeTasks(kept);
  return removed;
}
