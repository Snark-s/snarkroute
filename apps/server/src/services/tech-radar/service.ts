import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../errors";
import { radarDataRoot, startRadarScheduler } from "../radar";
import { analyseProject, compareCapabilities, meaningfulChanges, recommend, validateAnalysis } from "./analysis";
import { GithubSources, normalizeGithubUrl } from "./github";
import { capabilityCatalog, workshopInventory } from "./inventory";
import type { Analysis, AnalysisResult, Catalog, Decision, InventoryTool, Job, Snapshot } from "./types";

type Options = {
  directory?: string; collect?: (url: string, fresh?: boolean) => Promise<Snapshot>;
  analyse?: (snapshot: Snapshot, catalog: Catalog) => Promise<Analysis | AnalysisResult>;
  inventory?: () => Promise<InventoryTool[]>; now?: () => Date;
};
/** One durable serial queue, using the same JSON snapshot/atomic rename pattern as H3Queue. */
export class TechRadarService {
  readonly directory: string;
  private state: Catalog = { schemaVersion: 1, projects: [], jobs: [], inventory: [] };
  private ready?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private worker?: Promise<void>;
  private closed = false;
  private readonly lockOwner = randomUUID();
  private ownsLock = false;
  private stopScheduler?: () => void;
  private readonly collect: NonNullable<Options["collect"]>;
  private readonly analyse: NonNullable<Options["analyse"]>;
  private readonly inventory: NonNullable<Options["inventory"]>;
  private readonly now: () => Date;
  constructor(options: Options = {}) {
    this.directory = options.directory ?? join(radarDataRoot(), "tech-radar");
    const github = new GithubSources({ directory: join(this.directory, "github-cache") });
    this.collect = options.collect ?? ((url, fresh) => github.collect(url, fresh));
    this.analyse = options.analyse ?? analyseProject;
    this.inventory = options.inventory ?? workshopInventory;
    this.now = options.now ?? (() => new Date());
  }

  init(): Promise<void> {
    return this.ready ??= this.load().catch(async error => { await this.releaseLock(); throw error; });
  }
  get isClosed() { return this.closed; }
  private async load() {
    await mkdir(this.directory, { recursive: true });
    await this.acquireLock();
    try {
      const state = JSON.parse(await readFile(join(this.directory, "catalog.json"), "utf8")) as Catalog;
      if (state.schemaVersion !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.jobs) || !Array.isArray(state.inventory)) throw new Error("Invalid schema");
      for (const project of state.projects) {
        if (!Array.isArray(project.research) || !Array.isArray(project.decisions) || !project.watch || normalizeGithubUrl(project.canonicalUrl).sourceKey !== project.sourceKey) throw new Error("Invalid project");
      }
      if (state.jobs.some(job => !state.projects.some(p => p.id === job.projectId) || !["queued", "fetching", "analysing", "failed", "completed"].includes(job.status))) throw new Error("Invalid queue");
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Каталог Технорадара повреждён или имеет неизвестную версию. Файлы сохранены; восстановите catalog.backup.json вручную.");
    }
    const inventory = await this.inventory();
    await this.change(state => {
      state.inventory = inventory;
      // Comparison is derived from the current workshop catalog; research and decisions stay intact.
      for (const project of state.projects) {
        const latest = project.research.at(-1); if (!latest) continue;
        latest.comparison = compareCapabilities(latest.analysis, state, project.id);
        latest.recommendation = recommend(latest.analysis, latest.comparison, latest.snapshot);
      }
      for (const job of state.jobs) if (["fetching", "analysing"].includes(job.status)) { job.status = "queued"; job.updatedAt = this.timestamp(); }
    });
    this.kick();
  }

  async catalog() { await this.init(); await this.writes; return structuredClone(this.state); }
  async capabilities() { return capabilityCatalog(await this.catalog()); }

  async enqueue(url: string, repeat = false) {
    const link = normalizeGithubUrl(url); await this.init();
    if (this.closed) throw new Error("Технорадар остановлен.");
    const result = await this.change(state => {
      let project = state.projects.find(p => p.sourceKey === link.sourceKey);
      const active = project && state.jobs.find(j => j.projectId === project!.id && ["queued", "fetching", "analysing"].includes(j.status));
      if (project && (active || !repeat)) return { projectId: project.id, jobId: active?.id ?? state.jobs.filter(j => j.projectId === project!.id).at(-1)?.id, duplicate: true };
      if (state.jobs.filter(j => ["queued", "fetching", "analysing"].includes(j.status)).length >= 20) throw new Error("Очередь заполнена (20 исследований). Дождитесь завершения.");
      const now = this.timestamp();
      if (!project) {
        project = { id: `tech_${createHash("sha256").update(link.sourceKey).digest("hex").slice(0, 24)}`, sourceType: link.sourceType, sourceKey: link.sourceKey, canonicalUrl: link.canonicalUrl, name: link.repo, createdAt: now, research: [], decisions: [], watch: { enabled: false, intervalDays: 7 } };
        state.projects.push(project);
      }
      const job: Job = { id: randomUUID(), projectId: project.id, status: "queued", createdAt: now, updatedAt: now };
      project.watch.lastQueuedAt = now; state.jobs.push(job);
      return { projectId: project.id, jobId: job.id, duplicate: false };
    });
    this.kick(); return result;
  }

  async decide(id: string, status: Decision, note = "") {
    if (!["skip", "watch", "test", "review_integration"].includes(status) || typeof note !== "string" || note.length > 4000) throw new Error("Некорректное решение.");
    await this.init();
    return this.change(state => { const project = this.project(state, id); project.decisions.push({ status, note, at: this.timestamp() }); return project; });
  }
  async watch(id: string, enabled: boolean, intervalDays = 7) {
    if (typeof enabled !== "boolean" || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) throw new Error("Интервал проверки: целое число от 1 до 365 дней.");
    await this.init();
    return this.change(state => { const project = this.project(state, id); project.watch = { ...project.watch, enabled, intervalDays }; return project; });
  }
  async acknowledge(id: string) {
    await this.init(); return this.change(state => { const p = this.project(state, id); if (p.notification) p.notification.seen = true; return p; });
  }
  async checkDue() {
    const state = await this.catalog();
    for (const project of state.projects) {
      const status = project.decisions.at(-1)?.status ?? project.research.at(-1)?.recommendation.status;
      if (project.watch.enabled && status === "watch" && this.now().getTime() - Date.parse(project.watch.lastQueuedAt ?? project.createdAt) >= project.watch.intervalDays * 86_400_000) await this.enqueue(project.canonicalUrl, true);
    }
  }
  startScheduler() {
    if (this.stopScheduler) return;
    this.stopScheduler = startRadarScheduler({ radars: [], onTick: () => this.checkDue() });
  }
  async drain() {
    await this.init();
    this.kick();
    while (this.worker) await this.worker;
    await this.writes;
  }
  async close() { this.closed = true; this.stopScheduler?.(); try { await this.worker; await this.writes; } finally { await this.releaseLock(); } }

  private kick() {
    if (this.closed || this.worker) return;
    this.worker = Promise.resolve().then(() => this.runQueue()).finally(() => { this.worker = undefined; });
    // Errors remain visible in the job or API; prevent an unhandled rejection on a filesystem failure.
    void this.worker.catch(() => undefined);
  }
  private async runQueue() {
    while (!this.closed) {
      await this.writes;
      const job = this.state.jobs.find(j => j.status === "queued"); if (!job) return;
      try {
        await this.change(state => { const j = this.job(state, job.id); j.status = j.snapshot ? "analysing" : "fetching"; j.updatedAt = this.timestamp(); });
        const project = this.project(this.state, job.projectId);
        const snapshot = job.snapshot ?? await this.collect(project.canonicalUrl, project.research.length > 0);
        await this.change(state => { const j = this.job(state, job.id); j.snapshot = snapshot; j.status = "analysing"; j.updatedAt = this.timestamp(); });
        const analysed = await this.analyse(snapshot, structuredClone(this.state));
        const analysis = validateAnalysis("analysis" in analysed ? analysed.analysis : analysed, snapshot);
        const model = "analysis" in analysed ? analysed.model : { provider: "injected", model: "injected", providerCost: 0, baseCost: 0 };
        if ("analysis" in analysed && analysed.warnings) snapshot.warnings.push(...analysed.warnings);
        await this.change(state => {
          const p = this.project(state, job.projectId); const comparison = compareCapabilities(analysis, state, p.id);
          const changes = meaningfulChanges(p.research.at(-1), snapshot, analysis); const now = this.timestamp();
          p.name = snapshot.name;
          p.research.push({ id: job.id, completedAt: now, snapshot, analysis, comparison, recommendation: recommend(analysis, comparison, snapshot), changes, model });
          if (changes.length) p.notification = { at: now, changes, seen: false };
          const j = this.job(state, job.id); j.status = "completed"; j.updatedAt = now; delete j.snapshot;
        });
      } catch (error) {
        await this.change(state => { const j = this.job(state, job.id); j.status = "failed"; j.updatedAt = this.timestamp(); j.error = errorMessage(error).slice(0, 1000); });
      }
    }
  }
  private project(state: Catalog, id: string) { const project = state.projects.find(p => p.id === id); if (!project) throw new Error("Проект не найден."); return project; }
  private job(state: Catalog, id: string) { const job = state.jobs.find(j => j.id === id); if (!job) throw new Error("Исследование не найдено."); return job; }
  private timestamp() { return this.now().toISOString(); }
  private async acquireLock() {
    const path = join(this.directory, "catalog.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx");
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.lockOwner })); this.ownsLock = true; } finally { await handle.close(); }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = JSON.parse(await readFile(path, "utf8")) as { pid: number };
        if (!Number.isInteger(existing.pid) || existing.pid <= 0) throw new Error("Каталог заблокирован: некорректный файл catalog.lock.");
        try { process.kill(existing.pid, 0); } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") { await rm(path); continue; }
        }
        throw new Error("Каталог Технорадара уже открыт другим процессом. Живой smoke следует запускать при остановленном сервере.");
      }
    }
    throw new Error("Каталог Технорадара не удалось заблокировать.");
  }
  private async releaseLock() {
    if (!this.ownsLock) return;
    const path = join(this.directory, "catalog.lock");
    const existing = JSON.parse(await readFile(path, "utf8")) as { owner: string };
    if (existing.owner === this.lockOwner) await rm(path);
    this.ownsLock = false;
  }
  private change<T>(mutate: (state: Catalog) => T): Promise<T> {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state); const result = mutate(next);
      const path = join(this.directory, "catalog.json"); const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      try { await copyFile(path, join(this.directory, "catalog.backup.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // No in-place fallback: a failed atomic rename must leave the last committed catalog intact.
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; } catch (error) {
          if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * 2 ** attempt));
        }
      }
      this.state = next; return structuredClone(result);
    });
    this.writes = operation.catch(() => undefined); return operation;
  }
}

let shared: TechRadarService | undefined;
export function techRadarService() { if (!shared || shared.isClosed) shared = new TechRadarService(); return shared; }
