import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const H3_QUEUE_OPERATIONS = [
  "text_to_video",
  "first_last_frame",
  "motion_transfer",
  "reference_mix",
  "replace_object",
  "automatic_tracking",
  "regenerate_2k"
] as const;

export type H3QueueOperation = typeof H3_QUEUE_OPERATIONS[number];
export type H3QueueItemStatus = "ready" | "running" | "succeeded" | "failed" | "blocked";
export type H3SessionMode = "saved_worker" | "vast";
export type H3SessionStatus = "idle" | "connecting" | "rendering" | "cleaning" | "completed" | "completed_with_errors" | "failed" | "cleanup_failed";

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
  render(item: H3QueueItem, lease: H3QueueLease, onProgress: (progress: number, stage?: string) => Promise<void>): Promise<H3RenderResult>;
  cleanup(lease: H3QueueLease): Promise<void>;
};

export class H3QueueBlockedError extends Error {
  readonly name = "H3QueueBlockedError";
}

export class H3ManagedInstanceError extends Error {
  readonly name = "H3ManagedInstanceError";
  constructor(message: string, readonly managedInstanceId: number) { super(message); }
}

type CreateH3QueueItem = Pick<H3QueueItem, "title" | "operation" | "prompt"> & Partial<Pick<H3QueueItem, "promptJson" | "duration" | "aspectRatio" | "seed" | "variants" | "renderMode" | "inferenceSteps" | "assets">>;

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
    this.state.items = this.state.items.filter((candidate) => candidate.id !== id);
    await this.persist();
    return true;
  }

  async move(id: string, direction: -1 | 1): Promise<H3QueueState> {
    await this.initialize();
    const index = this.state.items.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.state.items.length) return clone(this.state);
    const [item] = this.state.items.splice(index, 1);
    this.state.items.splice(target, 0, item!);
    await this.persist();
    return clone(this.state);
  }

  async clearFinished(): Promise<H3QueueState> {
    await this.initialize();
    this.state.items = this.state.items.filter((item) => item.status === "ready" || item.status === "running");
    await this.persist();
    return clone(this.state);
  }

  async start(mode: H3SessionMode): Promise<H3QueueSession> {
    await this.initialize();
    if (this.activeRun || ["connecting", "rendering", "cleaning"].includes(this.state.session.status)) throw new Error("An H3 render session is already active.");
    if (!this.state.items.some((item) => item.status === "ready" || item.status === "failed" || item.status === "blocked")) throw new Error("The H3 queue has no jobs to render.");
    for (const item of this.state.items) {
      if (item.status === "failed" || item.status === "blocked") {
        item.status = "ready";
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
    await this.persist();
    this.activeRun = this.run(mode).finally(() => { this.activeRun = undefined; this.activeLease = undefined; });
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
      this.activeLease = lease;
      this.state.session.managedInstanceId = lease.managedInstanceId;
      this.state.session.offerId = lease.offerId;
      this.state.session.hourlyPriceUsd = lease.hourlyPriceUsd;
      this.state.session.status = "rendering";
      this.state.session.updatedAt = new Date().toISOString();
      await this.persist();

      for (const item of this.state.items) {
        if (item.status !== "ready") continue;
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
          const result = await this.runtime.render(item, lease, async (progress, stage) => {
            item.progress = Math.max(item.progress, Math.min(0.99, Math.max(0, progress)));
            item.stage = stage;
            item.updatedAt = this.state.session.updatedAt = new Date().toISOString();
            await this.persist();
          });
          item.status = "succeeded";
          item.progress = 1;
          item.stage = "complete";
          item.workerJobId = result.workerJobId;
          item.resultPaths = result.resultPaths;
          delete item.error;
        } catch (error) {
          item.status = error instanceof H3QueueBlockedError ? "blocked" : "failed";
          item.progress = 0;
          item.stage = item.status;
          item.error = errorMessage(error);
          finalStatus = "completed_with_errors";
        }
        item.completedAt = item.updatedAt = new Date().toISOString();
        await this.persist();
      }
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
    if (["connecting", "rendering", "cleaning"].includes(this.state.session.status)) {
      for (const item of this.state.items) {
        if (item.status === "running") {
          item.status = "failed";
          item.progress = 0;
          item.error = "SnarkRoute restarted while this item was running. Retry it after checking the worker.";
          item.completedAt = item.updatedAt = new Date().toISOString();
        }
      }
      this.state.session.status = this.state.session.managedInstanceId ? "cleanup_failed" : "failed";
      this.state.session.cleanupConfirmed = this.state.session.managedInstanceId ? false : null;
      this.state.session.error = this.state.session.managedInstanceId
        ? "SnarkRoute restarted before Vast cleanup was confirmed. Retry cleanup for the exact recorded instance."
        : "SnarkRoute restarted before the render session completed.";
      this.state.session.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, this.path());
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
  const renderMode = value.renderMode === "preview" ? "preview" : "final";
  const inferenceSteps = value.inferenceSteps === undefined ? undefined : integer(value.inferenceSteps, renderMode === "preview" ? 4 : 20, renderMode === "preview" ? 10 : 40, "inferenceSteps");
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
    ...(inferenceSteps === undefined ? {} : { inferenceSteps }),
    assets,
    status: value.status,
    progress: value.progress,
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

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function clone<T>(value: T): T { return structuredClone(value); }
