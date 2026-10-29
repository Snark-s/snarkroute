import { resolve } from "node:path";

/**
 * Named locks for shared working copies, files, browser profiles and services.
 * Path locks conflict when one path contains the other. A lock outlives a
 * crash: after a restart it is "suspect" and stays held until its owner task is
 * reconciled, so two owners can never exist at once. Every grant carries a
 * monotonically increasing fencing number.
 */

export type LockRecord = { key: string; ownerTaskId: string; ownerAgentId: string; fencing: number; acquiredAt: string; heartbeatAt: string; state: "held" | "suspect" };

export type LockConflict = { key: string; heldBy: string; ownerAgentId: string; state: LockRecord["state"] };

export class LockManager {
  private locks = new Map<string, LockRecord>();
  private fencing = 0;

  constructor(private readonly options: { persist?: (state: { locks: LockRecord[]; fencing: number }) => Promise<void>; now?: () => number } = {}) {}

  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }

  restore(state: { locks?: LockRecord[]; fencing?: number }): void {
    for (const lock of state.locks ?? []) this.locks.set(lock.key, { ...lock, state: "suspect" });
    this.fencing = Math.max(this.fencing, state.fencing ?? 0, ...(state.locks ?? []).map(lock => lock.fencing));
  }

  list(): LockRecord[] { return [...this.locks.values()]; }

  /** All-or-nothing; re-acquiring keys the owner already holds is allowed. */
  tryAcquire(keys: string[], owner: { taskId: string; agentId: string }): { ok: true; fencing: number } | { ok: false; conflicts: LockConflict[] } {
    const normalized = [...new Set(keys.map(normalizeLockKey))];
    const conflicts: LockConflict[] = [];
    for (const key of normalized) {
      for (const lock of this.locks.values()) {
        if (lock.ownerTaskId !== owner.taskId && lockKeysOverlap(key, lock.key)) conflicts.push({ key: lock.key, heldBy: lock.ownerTaskId, ownerAgentId: lock.ownerAgentId, state: lock.state });
      }
    }
    if (conflicts.length) return { ok: false, conflicts };
    const fencing = ++this.fencing;
    const at = this.now();
    for (const key of normalized) {
      const existing = this.locks.get(key);
      this.locks.set(key, { key, ownerTaskId: owner.taskId, ownerAgentId: owner.agentId, fencing, acquiredAt: existing?.acquiredAt ?? at, heartbeatAt: at, state: "held" });
    }
    void this.save();
    return { ok: true, fencing };
  }

  /** The owner task was confirmed alive after a restart. */
  confirm(taskId: string): void {
    for (const lock of this.locks.values()) if (lock.ownerTaskId === taskId) { lock.state = "held"; lock.heartbeatAt = this.now(); }
    void this.save();
  }

  heldBy(taskId: string): LockRecord[] { return this.list().filter(lock => lock.ownerTaskId === taskId); }

  releaseOwner(taskId: string): number {
    let released = 0;
    for (const [key, lock] of this.locks) if (lock.ownerTaskId === taskId) { this.locks.delete(key); released += 1; }
    if (released) void this.save();
    return released;
  }

  private async save(): Promise<void> {
    await this.options.persist?.({ locks: this.list(), fencing: this.fencing }).catch(() => undefined);
  }
}

export function workspaceLockKey(path: string): string { return `workspace:${resolve(path)}`; }

export function normalizeLockKey(key: string): string {
  const separator = key.indexOf(":");
  if (separator < 0) throw new Error(`Lock key needs a kind prefix: ${key}`);
  const kind = key.slice(0, separator);
  const value = key.slice(separator + 1);
  if (kind === "workspace" || kind === "file") return `${kind}:${pathKey(value)}`;
  if (["browser", "service", "runtime"].includes(kind)) return `${kind}:${value.trim().toLowerCase()}`;
  throw new Error(`Unknown lock kind: ${kind}`);
}

export function lockKeysOverlap(a: string, b: string): boolean {
  const [kindA, valueA] = splitKey(a);
  const [kindB, valueB] = splitKey(b);
  const pathLike = (kind: string) => kind === "workspace" || kind === "file";
  if (pathLike(kindA) && pathLike(kindB)) return valueA === valueB || valueA.startsWith(`${valueB}\\`) || valueB.startsWith(`${valueA}\\`)
    || valueA.startsWith(`${valueB}/`) || valueB.startsWith(`${valueA}/`);
  return kindA === kindB && valueA === valueB;
}

function splitKey(key: string): [string, string] {
  const separator = key.indexOf(":");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function pathKey(value: string): string {
  const absolute = resolve(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
