import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export const H3_QUEUE_OPERATIONS = [
  "text_to_video",
  "first_last_frame",
  "motion_transfer",
  "style_transfer",
  "reference_mix",
  "replace_object",
  "automatic_tracking",
  "regenerate_2k"
] as const;

export type H3QueueOperation = typeof H3_QUEUE_OPERATIONS[number];
export type H3QueueItemStatus = "ready" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export type H3SessionMode = "saved_worker" | "vast";
export type H3SessionStatus = "idle" | "connecting" | "rendering" | "cancelling" | "cleaning" | "completed" | "completed_with_errors" | "cancelled" | "failed" | "cleanup_failed";

export type H3QueueAsset = {
  slot: "firstFrame" | "lastFrame" | "referenceImage" | "referenceVideo" | "referenceAudio" | "sourceVideo" | "mask";
  kind: "image" | "video" | "audio";
  path: string;
  filename: string;
  mimeType: string;
};

export type H3QueueItem = {
  id: string;
  title: string;
  operation: H3QueueOperation;
  prompt: string;
  promptJson?: Record<string, unknown>;
  duration: number;
  aspectRatio: string;
  seed?: number;
  variants: number;
  renderMode: "preview" | "final";
  modelVariant: "h3_base" | "10eros_max" | "10eros_max_turbo";
  inferenceSteps?: number;
  assets: H3QueueAsset[];
  status: H3QueueItemStatus;
  progress: number;
  stage?: string;
  workerJobId?: string;
  resultPaths?: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  selectedForRun?: boolean;
  archivedAt?: string;
};

export type H3QueueSession = {
  id: string;
  mode: H3SessionMode;
  status: H3SessionStatus;
  currentItemId?: string;
  managedInstanceId?: number;
  offerId?: number;
  hourlyPriceUsd?: number;
  cleanupConfirmed: boolean | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type H3QueueState = {
  version: 1;
  items: H3QueueItem[];
  session: H3QueueSession;
};

export type H3QueueLease = {
  workerUrl: string;
  serviceToken: string;
  managedInstanceId?: number;
  offerId?: number;
  hourlyPriceUsd?: number;
};

export type H3RenderResult = {
  workerJobId: string;
  resultPaths: string[];
};

export type H3QueueRuntime = {
  acquire(mode: H3SessionMode, onLease: (lease: H3QueueLease) => Promise<void>): Promise<H3QueueLease>;
  render(item: H3QueueItem, lease: H3QueueLease, onProgress: (progress: number, stage?: string) => Promise<void>, onJobCreated?: (workerJobId: string) => Promise<void>): Promise<H3RenderResult>;
  cancel?(item: H3QueueItem, lease: H3QueueLease): Promise<void>;
  cleanup(lease: H3QueueLease): Promise<void>;
};

export class H3QueueBlockedError extends Error {
  readonly name = "H3QueueBlockedError";
}

export class H3ManagedInstanceError extends Error {
  readonly name = "H3ManagedInstanceError";
  constructor(message: string, readonly managedInstanceId: number) { super(message); }
}

type CreateH3QueueItem = Pick<H3QueueItem, "title" | "operation" | "prompt"> & Partial<Pick<H3QueueItem, "promptJson" | "duration" | "aspectRatio" | "seed" | "variants" | "renderMode" | "modelVariant" | "inferenceSteps" | "assets">>;

const IDLE_SESSION: H3QueueSession = {
  id: "session_idle",
  mode: "saved_worker",
  status: "idle",
  cleanupConfirmed: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

export class H3QueueService {
  readonly directory: string;
  private readonly runtime: H3QueueRuntime;
  private state: H3QueueState = { version: 1, items: [], session: { ...IDLE_SESSION } };
  private initialized?: Promise<void>;
  private activeRun?: Promise<void>;
  private activeLease?: H3QueueLease;
  private stopRequested = false;
  private cancellationDispatched = false;
  private persistence = Promise.resolve();

  constructor(options: { directory: string; runtime: H3QueueRuntime }) {
    this.directory = options.directory;
    this.runtime = options.runtime;
  }

  async getState(): Promise<H3QueueState> {
    await this.initialize();
    return clone(this.state);
  }

  async create(input: CreateH3QueueItem): Promise<H3QueueItem> {
    await this.initialize();
    const now = new Date().toISOString();
    const item = normalizeItem({
      ...input,
      id: `h3q_${randomUUID()}`,
      status: "ready",
      progress: 0,
      createdAt: now,
      updatedAt: now
    });
    this.state.items.push(item);
    await this.persist();
    return clone(item);
  }

  async update(id: string, input: Partial<CreateH3QueueItem>): Promise<H3QueueItem | null> {
    await this.initialize();
    const index = this.state.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const current = this.state.items[index]!;
    if (current.status === "running") throw new Error("A running H3 queue item cannot be edited.");
    const next = normalizeItem({
      ...current,
      ...input,
      id: current.id,
      status: "ready",
      progress: 0,
      workerJobId: undefined,
      resultPaths: undefined,
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    this.state.items[index] = next;
    await this.persist();
    return clone(next);
  }

  async remove(id: string): Promise<boolean> {
    await this.initialize();
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) return false;
    if (item.status === "running") throw new Error("A running H3 queue item cannot be removed.");
    await this.trashResults(id);
    this.state.items = this.state.items.filter((candidate) => candidate.id !== id);
    await this.persist();
    return true;
  }

  async setSelected(id: string, selected: boolean): Promise<H3QueueItem | null> {
    await this.initialize();
    const item = this.state.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    if (item.status === "running") throw new Error("A running H3 queue item cannot be skipped.");
    if (item.archivedAt) throw new Error("Restore an archived H3 queue item before selecting it.");
    item.selectedForRun = selected;
    item.updatedAt = new Date().toISOString();
    await this.persist();
    return clone(item);
  }

  async archive(id: string): Promise<H3QueueItem | null> {
    await this.initialize();
    const index = this.state.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return null;
    const item = this.state.items[index]!;
    if (item.status === "running") throw new Error("A running H3 queue item cannot be archived.");
    item.archivedAt = new Date().toISOString();
    item.selectedForRun = false;
    item.updatedAt = item.archivedAt;
    this.state.items.splice(index, 1);
    this.state.items.push(item);
    await this.persist();
    return clone(item);
  }

  async restore(id: string): Promise<H3QueueItem | null> {
    await this.initialize();
    const index = this.state.items.findIndex((candidate) => candidate.id === id);
    if (index < 0) return null;
    const item = this.state.items[index]!;
    if (!item.archivedAt) return clone(item);
    delete item.archivedAt;
    item.selectedForRun = true;
    item.updatedAt = new Date().toISOString();
    this.state.items.splice(index, 1);
    const firstArchived = this.state.items.findIndex((candidate) => Boolean(candidate.archivedAt));
    this.state.items.splice(firstArchived < 0 ? this.state.items.length : firstArchived, 0, item);
    await this.persist();
    return clone(item);
  }

  async move(id: string, direction: -1 | 1): Promise<H3QueueState> {
    await this.initialize();
    const activeItems = this.state.items.filter((item) => !item.archivedAt);
    const index = activeItems.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= activeItems.length) return clone(this.state);
    const sourceIndex = this.state.items.findIndex((item) => item.id === activeItems[index]!.id);
    const targetIndex = this.state.items.findIndex((item) => item.id === activeItems[target]!.id);
    [this.state.items[sourceIndex], this.state.items[targetIndex]] = [this.state.items[targetIndex]!, this.state.items[sourceIndex]!];
    await this.persist();
    return clone(this.state);
  }

  async clearFinished(): Promise<H3QueueState> {
    await this.initialize();
    const finished = this.state.items.filter((item) => !item.archivedAt && item.status !== "ready" && item.status !== "running");
    for (const item of finished) await this.remove(item.id);
    return clone(this.state);
  }

  private async trashResults(id: string): Promise<boolean> {
    if (!/^h3q_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid H3 result folder.");
    const source = resolve(this.directory, "results", id);
    // Results may be reused as inputs by another task, including archived tasks.
    if (this.state.items.some((item) => item.id !== id && [...item.assets.map((asset) => asset.path), ...(item.resultPaths ?? [])]
      .some((path) => resolve(path) === source || resolve(path).startsWith(source + sep)))) return false;
    const trash = resolve(this.directory, ".trash", "results");
    await mkdir(trash, { recursive: true });
    try {
      await rename(source, join(trash, `${id}-${randomUUID()}`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async collectOrphanResults(): Promise<{ movedCount: number }> {
    await this.initialize();
    const entries = await readdir(join(this.directory, "results"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let movedCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && /^h3q_[a-zA-Z0-9_-]+$/.test(entry.name) && !this.state.items.some((item) => item.id === entry.name)) {
        if (await this.trashResults(entry.name)) movedCount++;
      }
    }
    return { movedCount };
  }

  async emptyTrash(): Promise<{ deletedCount: number }> {
    const trash = resolve(this.directory, ".trash", "results");
    const entries = await readdir(trash).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let deletedCount = 0;
    for (const entry of entries) {
      const target = resolve(trash, entry);
      if (!target.startsWith(trash + sep)) throw new Error("Invalid trash path.");
      await rm(target, { recursive: true, force: true });
      deletedCount++;
    }
    return { deletedCount };
  }

  async start(mode: H3SessionMode): Promise<H3QueueSession> {
    await this.initialize();
    if (this.activeRun || ["connecting", "rendering", "cancelling", "cleaning"].includes(this.state.session.status)) throw new Error("An H3 render session is already active.");
    if (!this.state.items.some((item) => isRunnable(item))) throw new Error("Select at least one non-archived H3 job to render.");
    for (const item of this.state.items) {
      if (isRunnable(item) && (item.status === "failed" || item.status === "blocked" || item.status === "cancelled")) {
        item.status = "ready";
        delete item.stage;
        item.progress = 0;
        delete item.error;
        delete item.completedAt;
      }
    }
    const now = new Date().toISOString();
    this.state.session = {
      id: `h3s_${randomUUID()}`,
      mode,
      status: "connecting",
      cleanupConfirmed: null,
      createdAt: now,
      updatedAt: now
    };
    this.stopRequested = false;
    this.cancellationDispatched = false;
    await this.persist();
    this.activeRun = this.run(mode).catch((error) => {
      // A failed final disk write must not become an unhandled rejection
      // that terminates the API and leaves every client showing stale progress.
      this.state.session.status = this.state.session.managedInstanceId && this.state.session.cleanupConfirmed !== true ? "cleanup_failed" : "failed";
      this.state.session.error = `Could not save H3 queue state: ${errorMessage(error)}`;
      this.state.session.updatedAt = new Date().toISOString();
    }).finally(() => {
      this.activeRun = undefined;
      this.activeLease = undefined;
      this.stopRequested = false;
      this.cancellationDispatched = false;
    });
    return clone(this.state.session);
  }

  async cancelActive(): Promise<H3QueueSession> {
    await this.initialize();
    const item = this.state.items.find((candidate) => candidate.id === this.state.session.currentItemId);
    if (!this.activeRun || !item || item.status !== "running" || !this.activeLease) {
      throw new Error("There is no active H3 generation to stop.");
    }
    this.stopRequested = true;
    this.state.session.status = "cancelling";
    this.state.session.updatedAt = new Date().toISOString();
    item.stage = "cancelling";
    item.updatedAt = this.state.session.updatedAt;
    await this.persist();
    if (item.workerJobId && this.runtime.cancel && !this.cancellationDispatched) {
      this.cancellationDispatched = true;
      try { await this.runtime.cancel(item, this.activeLease); }
      catch (error) { this.cancellationDispatched = false; throw error; }
    }
    return clone(this.state.session);
  }

  async waitForSettled(): Promise<H3QueueState> {
    await this.activeRun;
    return this.getState();
  }

  async retryCleanup(): Promise<H3QueueSession> {
    await this.initialize();
    if (this.state.session.status !== "cleanup_failed" || !this.state.session.managedInstanceId) throw new Error("There is no unconfirmed managed Vast instance to clean up.");
    const lease = this.activeLease ?? {
      workerUrl: "",
      serviceToken: "",
      managedInstanceId: this.state.session.managedInstanceId,
      offerId: this.state.session.offerId,
      hourlyPriceUsd: this.state.session.hourlyPriceUsd
    };
    this.state.session.status = "cleaning";
    this.state.session.updatedAt = new Date().toISOString();
    await this.persist();
    try {
      await this.runtime.cleanup(lease);
      this.state.session.cleanupConfirmed = true;
      this.state.session.status = this.state.items.some((item) => item.status === "failed" || item.status === "blocked") ? "completed_with_errors" : "completed";
      delete this.state.session.error;
      this.state.session.completedAt = this.state.session.updatedAt = new Date().toISOString();
    } catch (error) {
      this.state.session.status = "cleanup_failed";
      this.state.session.cleanupConfirmed = false;
      this.state.session.error = errorMessage(error);
      this.state.session.updatedAt = new Date().toISOString();
    }
    await this.persist();
    return clone(this.state.session);
  }

  private async run(mode: H3SessionMode): Promise<void> {
    let lease: H3QueueLease | undefined;
    let finalStatus: H3SessionStatus = "completed";
    try {
      lease = await this.runtime.acquire(mode, async (acquiredLease) => {
        this.activeLease = acquiredLease;
        this.state.session.managedInstanceId = acquiredLease.managedInstanceId;
        this.state.session.offerId = acquiredLease.offerId;
        this.state.session.hourlyPriceUsd = acquiredLease.hourlyPriceUsd;
        this.state.session.updatedAt = new Date().toISOString();
        await this.persist();
      });
      const renderLease = lease;
      this.activeLease = lease;
      this.state.session.managedInstanceId = lease.managedInstanceId;
      this.state.session.offerId = lease.offerId;
      this.state.session.hourlyPriceUsd = lease.hourlyPriceUsd;
      this.state.session.status = "rendering";
      this.state.session.updatedAt = new Date().toISOString();
      await this.persist();

      for (const item of this.state.items) {
        if (this.stopRequested) break;
        if (item.archivedAt || item.selectedForRun === false || item.status !== "ready") continue;
        const now = new Date().toISOString();
        item.status = "running";
        item.stage = "starting";
        item.progress = 0;
        item.startedAt = now;
        item.updatedAt = now;
        this.state.session.currentItemId = item.id;
        this.state.session.updatedAt = now;
        await this.persist();
        try {
          const result = await this.runtime.render(
            item,
            renderLease,
            async (progress, stage) => {
              item.progress = Math.max(item.progress, Math.min(0.99, Math.max(0, progress)));
              item.stage = stage;
              item.updatedAt = this.state.session.updatedAt = new Date().toISOString();
              await this.persist();
            },
            async (workerJobId) => {
              item.workerJobId = workerJobId;
              item.updatedAt = this.state.session.updatedAt = new Date().toISOString();
              await this.persist();
              if (this.stopRequested && this.runtime.cancel && !this.cancellationDispatched) {
                this.cancellationDispatched = true;
                try { await this.runtime.cancel(item, renderLease); }
                catch (error) { this.cancellationDispatched = false; throw error; }
              }
            }
          );
          item.status = "succeeded";
          item.progress = 1;
          item.stage = "complete";
          item.workerJobId = result.workerJobId;
          item.resultPaths = result.resultPaths;
          delete item.error;
        } catch (error) {
          item.status = this.stopRequested ? "cancelled" : error instanceof H3QueueBlockedError ? "blocked" : "failed";
          item.progress = 0;
          item.stage = item.status;
          item.error = this.stopRequested ? "Generation stopped by the user." : errorMessage(error);
          finalStatus = this.stopRequested ? "cancelled" : "completed_with_errors";
        }
        item.completedAt = item.updatedAt = new Date().toISOString();
        await this.persist();
        if (this.stopRequested) break;
      }
      if (this.stopRequested && finalStatus === "completed") finalStatus = "cancelled";
    } catch (error) {
      finalStatus = "failed";
      this.state.session.error = errorMessage(error);
      if (error instanceof H3ManagedInstanceError) {
        this.state.session.managedInstanceId = error.managedInstanceId;
        this.state.session.cleanupConfirmed = false;
        finalStatus = "cleanup_failed";
      }
    } finally {
      delete this.state.session.currentItemId;
      const cleanupLease = lease ?? this.activeLease;
      if (cleanupLease) {
        this.state.session.status = "cleaning";
        this.state.session.updatedAt = new Date().toISOString();
        await this.persist();
        try {
          await this.runtime.cleanup(cleanupLease);
          this.state.session.cleanupConfirmed = true;
          this.state.session.status = finalStatus;
        } catch (cleanupError) {
          this.state.session.cleanupConfirmed = false;
          this.state.session.status = "cleanup_failed";
          this.state.session.error = errorMessage(cleanupError);
        }
      } else {
        this.state.session.cleanupConfirmed = finalStatus === "cleanup_failed" ? false : mode === "saved_worker" ? true : false;
        this.state.session.status = finalStatus;
      }
      this.state.session.completedAt = this.state.session.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load();
    await this.initialized;
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as H3QueueState;
      if (parsed?.version === 1 && Array.isArray(parsed.items) && parsed.session) this.state = parsed;
    } catch {
      return;
    }
    for (const item of this.state.items) {
      if (item.status === "ready") delete item.stage;
    }
    if (["connecting", "rendering", "cancelling", "cleaning"].includes(this.state.session.status)) {
      const cancellationWasPending = this.state.session.status === "cancelling";
      for (const item of this.state.items) {
        if (item.status === "running") {
          item.status = cancellationWasPending ? "cancelled" : "failed";
          item.progress = 0;
          item.error = cancellationWasPending
            ? "Generation cancellation was interrupted by a SnarkRoute restart. Check the worker before retrying."
            : "SnarkRoute restarted while this item was running. Retry it after checking the worker.";
          item.completedAt = item.updatedAt = new Date().toISOString();
        }
      }
      this.state.session.status = this.state.session.managedInstanceId ? "cleanup_failed" : cancellationWasPending ? "cancelled" : "failed";
      this.state.session.cleanupConfirmed = this.state.session.managedInstanceId ? false : null;
      this.state.session.error = this.state.session.managedInstanceId
        ? "SnarkRoute restarted before Vast cleanup was confirmed. Retry cleanup for the exact recorded instance."
        : "SnarkRoute restarted before the render session completed.";
      this.state.session.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    const write = async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.path()}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, this.path());
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
          if (attempt >= 6) {
            // Some Windows/network-drive readers allow writes but deny replacement renames.
            // Preserve queue progress with an in-place fallback instead of losing a completed render.
            await writeFile(this.path(), snapshot, "utf8");
            await rm(temporary, { force: true });
            break;
          }
          // Windows readers/indexers can briefly lock the destination.
          // Keep the previous snapshot intact until atomic replacement succeeds.
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }
    };
    this.persistence = this.persistence.then(write, write);
    return this.persistence;
  }

  private path(): string { return join(this.directory, "queue.json"); }
}

function normalizeItem(value: Partial<H3QueueItem> & Pick<H3QueueItem, "id" | "title" | "operation" | "prompt" | "status" | "progress" | "createdAt" | "updatedAt">): H3QueueItem {
  const title = String(value.title ?? "").trim();
  const prompt = String(value.prompt ?? "").trim();
  if (!title || title.length > 160) throw new Error("H3 queue title must be between 1 and 160 characters.");
  if (!H3_QUEUE_OPERATIONS.includes(value.operation)) throw new Error("Unsupported H3 queue operation.");
  if (!prompt || prompt.length > 20_000) throw new Error("H3 queue prompt must be between 1 and 20000 characters.");
  const duration = integer(value.duration ?? 5, 4, 15, "duration");
  const variants = integer(value.variants ?? 1, 1, 10, "variants");
  const modelVariant = value.modelVariant === "10eros_max" || value.modelVariant === "10eros_max_turbo" ? value.modelVariant : "h3_base";
  const renderMode = value.renderMode === "preview" || value.renderMode === "final" ? value.renderMode : modelVariant === "10eros_max" ? "final" : "preview";
  const inferenceSteps = value.inferenceSteps === undefined ? undefined : integer(value.inferenceSteps, modelVariant.startsWith("10eros_") ? 4 : renderMode === "preview" ? 4 : 20, modelVariant.startsWith("10eros_") ? 8 : renderMode === "preview" ? 10 : 40, "inferenceSteps");
  const seed = value.seed === undefined ? randomInt(0, 2_147_483_648) : integer(value.seed, 0, 2_147_483_647, "seed");
  const promptJson = value.promptJson && typeof value.promptJson === "object" && !Array.isArray(value.promptJson) ? value.promptJson : undefined;
  const assets = Array.isArray(value.assets) ? value.assets.map(normalizeAsset) : [];
  return {
    ...value,
    id: value.id,
    title,
    operation: value.operation,
    prompt,
    ...(promptJson ? { promptJson } : {}),
    duration,
    aspectRatio: String(value.aspectRatio ?? "auto").trim() || "auto",
    seed,
    variants,
    renderMode,
    modelVariant,
    ...(inferenceSteps === undefined ? {} : { inferenceSteps }),
    assets,
    status: value.status,
    progress: value.progress,
    selectedForRun: value.selectedForRun !== false,
    ...(value.archivedAt ? { archivedAt: value.archivedAt } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

function normalizeAsset(value: H3QueueAsset): H3QueueAsset {
  if (!value || !["firstFrame", "lastFrame", "referenceImage", "referenceVideo", "referenceAudio", "sourceVideo", "mask"].includes(value.slot)) throw new Error("Unsupported H3 asset slot.");
  if (!["image", "video", "audio"].includes(value.kind)) throw new Error("Unsupported H3 asset kind.");
  const path = String(value.path ?? "").trim();
  const filename = String(value.filename ?? "").trim();
  const mimeType = String(value.mimeType ?? "").trim();
  if (!path || !filename || !mimeType) throw new Error("H3 queue assets require path, filename, and mimeType.");
  return { slot: value.slot, kind: value.kind, path, filename, mimeType };
}

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function isRunnable(item: H3QueueItem): boolean {
  return !item.archivedAt && item.selectedForRun !== false && ["ready", "failed", "blocked", "cancelled"].includes(item.status);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function clone<T>(value: T): T { return structuredClone(value); }
