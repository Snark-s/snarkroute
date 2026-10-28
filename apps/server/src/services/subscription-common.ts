import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Pieces shared by the owner's flat-rate subscription providers (Claude Code CLI,
 * Codex CLI): bounded concurrency, per-conversation ordering and small JSON stores.
 */

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

/** At most `limit()` tasks at once; queued callers can leave the queue through their AbortSignal. */
export class ConcurrencyGate {
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number, private readonly cancelled: () => Error) {}

  get active(): number { return this.running; }
  get queued(): number { return this.waiters.length; }

  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    while (this.running >= this.limit()) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { this.waiters = this.waiters.filter(waiter => waiter !== wake); reject(this.cancelled()); };
        const wake = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
    this.running += 1;
    try { return await task(); }
    finally { this.running -= 1; this.waiters.shift()?.(); }
  }
}

/** Turns of one conversation never interleave; different keys run independently. */
export class KeyedSerializer {
  private locks = new Map<string, Promise<unknown>>();

  async run<T>(key: string | undefined, task: () => Promise<T>): Promise<T> {
    if (!key) return task();
    const next = (this.locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
}

/** Append-only JSON array capped at `limit` entries (request history). */
export class JsonHistoryFile<T> {
  private entries?: T[];

  constructor(private readonly path: () => string, private readonly limit: number) {}

  async load(): Promise<T[]> {
    if (this.entries) return this.entries;
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as unknown;
      this.entries = Array.isArray(parsed) ? parsed.slice(-this.limit) as T[] : [];
    } catch { this.entries = []; }
    return this.entries;
  }

  async record(entry: T): Promise<void> {
    const entries = await this.load();
    entries.push(entry);
    if (entries.length > this.limit) entries.splice(0, entries.length - this.limit);
    await writeJsonAtomic(this.path(), entries).catch(() => undefined);
  }
}

/** Map of SnarkRoute conversation id -> provider session, persisted as a JSON array. */
export class JsonConversationFile<T extends { id: string; sessionId: string }> {
  private conversations?: Map<string, T>;

  constructor(private readonly path: () => string) {}

  async load(): Promise<Map<string, T>> {
    if (this.conversations) return this.conversations;
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as unknown;
      this.conversations = new Map((Array.isArray(parsed) ? parsed as T[] : []).filter(item => item?.id && item.sessionId).map(item => [item.id, item]));
    } catch { this.conversations = new Map(); }
    return this.conversations;
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.path(), [...(this.conversations ?? new Map()).values()]);
  }

  async list(): Promise<T[]> {
    return [...(await this.load()).values()].sort((a, b) => String((b as Record<string, unknown>).updatedAt ?? "").localeCompare(String((a as Record<string, unknown>).updatedAt ?? "")));
  }
}

export function boundedConcurrency(value: string | undefined, fallback = 2): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : fallback;
}
