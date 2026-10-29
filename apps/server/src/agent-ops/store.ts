import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentTask, TaskEvent } from "./types";

const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

/** JSON files under data/agent-ops: state documents, one file per task, append-only events and logs. */
export class AgentOpsStore {
  private writes = new Map<string, Promise<unknown>>();

  constructor(readonly directory: string) {}

  path(...parts: string[]): string { return join(this.directory, ...parts); }

  /** Resolves when every pending document write has reached the disk. */
  async flush(): Promise<void> {
    while (this.writes.size) await Promise.allSettled([...this.writes.values()]);
  }

  async readState<T>(name: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.path(`${name}.json`), "utf8")) as T; }
    catch { return fallback; }
  }

  writeState(name: string, value: unknown): Promise<void> {
    return this.writeJson(this.path(`${name}.json`), value);
  }

  saveTask(task: AgentTask): Promise<void> {
    return this.writeJson(this.path("tasks", task.id, "task.json"), task);
  }

  async loadTasks(): Promise<AgentTask[]> {
    const root = this.path("tasks");
    const ids = await readdir(root).catch(() => [] as string[]);
    const tasks: AgentTask[] = [];
    for (const id of ids) {
      try { tasks.push(JSON.parse(await readFile(join(root, id, "task.json"), "utf8")) as AgentTask); }
      catch { /* a half-written directory is skipped, never guessed */ }
    }
    return tasks;
  }

  taskDirectory(id: string): string { return this.path("tasks", id); }

  async appendEvent(id: string, event: TaskEvent): Promise<void> {
    await mkdir(this.taskDirectory(id), { recursive: true });
    await appendFile(join(this.taskDirectory(id), "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }

  async readEvents(id: string, limit = 200): Promise<TaskEvent[]> {
    try {
      const lines = (await readFile(join(this.taskDirectory(id), "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).map(line => JSON.parse(line) as TaskEvent);
    } catch { return []; }
  }

  /** Executor output, capped so a chatty run cannot fill the disk. */
  async appendLog(id: string, text: string): Promise<void> {
    const file = join(this.taskDirectory(id), "executor.log");
    await mkdir(this.taskDirectory(id), { recursive: true });
    const size = await stat(file).then(info => info.size).catch(() => 0);
    if (size >= LOG_LIMIT_BYTES) return;
    const chunk = size + Buffer.byteLength(text) > LOG_LIMIT_BYTES ? `${text.slice(0, LOG_LIMIT_BYTES - size)}\n[log truncated]\n` : text;
    await appendFile(file, chunk, "utf8");
  }

  async readLog(id: string, tailBytes = 64 * 1024): Promise<string> {
    try {
      const text = await readFile(join(this.taskDirectory(id), "executor.log"), "utf8");
      return text.length > tailBytes ? text.slice(-tailBytes) : text;
    } catch { return ""; }
  }

  async readArtifact(id: string, name: string): Promise<string> {
    return readFile(join(this.taskDirectory(id), name), "utf8");
  }

  async writeArtifact(id: string, name: string, content: string): Promise<string> {
    const file = join(this.taskDirectory(id), name);
    await mkdir(this.taskDirectory(id), { recursive: true });
    await writeFile(file, content, "utf8");
    return file;
  }

  /** Writes to one file are serialized; rename keeps a crash from leaving half a document. */
  private writeJson(file: string, value: unknown): Promise<void> {
    const previous = this.writes.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await mkdir(join(file, ".."), { recursive: true });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(temporary, file); return; }
        catch (error) {
          // Windows refuses a rename while an antivirus or reader holds the target briefly.
          if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            await rm(temporary, { force: true });
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
    });
    this.writes.set(file, next);
    void next.finally(() => { if (this.writes.get(file) === next) this.writes.delete(file); }).catch(() => undefined);
    return next;
  }
}
