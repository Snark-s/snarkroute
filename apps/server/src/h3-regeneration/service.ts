import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createH3RegenerationClient, estimateH3Regeneration, type H3RegenerationQuote } from "@snarkroute/h3";
import { modelGatewayJobsDirectory } from "../server-paths";
import { errorMessage } from "../services/errors";
import { portableToolJobService, type PortableToolJobService } from "../tool-jobs/service";

type RegenerationClient = ReturnType<typeof createH3RegenerationClient>;
export type H3RegenerationStatus = "queued" | "regenerating_2k" | "downloading" | "completed" | "failed" | "cancelled";
export type H3RegenerationJob = {
  id: string;
  sourceToolJobId: string;
  sourceResultId: string;
  sourceContext?: Record<string, unknown>;
  status: H3RegenerationStatus;
  progress: number;
  quote: H3RegenerationQuote;
  costs?: H3RegenerationQuote;
  providerJobId?: string;
  result?: { type: "video"; filename: string; url: string };
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export class H3RegenerationService {
  private readonly jobs = new Map<string, H3RegenerationJob>();
  private readonly creationLocks = new Map<string, Promise<H3RegenerationJob>>();

  constructor(
    private readonly directory = `${modelGatewayJobsDirectory}-h3-regeneration`,
    private readonly toolJobs: Pick<PortableToolJobService, "get"> = portableToolJobService,
    private readonly client: RegenerationClient = createH3RegenerationClient()
  ) {}

  availability(duration = 5) {
    return { available: this.client.configured, reason: this.client.configured ? undefined : "MINIMAX_API_KEY is not configured on the SnarkRoute backend.", quote: estimateH3Regeneration(duration) };
  }

  async create(input: { sourceToolJobId: string; resultId?: string; idempotencyKey?: string }): Promise<H3RegenerationJob> {
    if (!this.client.configured) throw new Error("Regenerate in 2K is unavailable because MINIMAX_API_KEY is not configured on the backend.");
    const source = await this.toolJobs.get(input.sourceToolJobId);
    if (!source || source.status !== "completed" || source.request.toolId !== "minimax.h3.generate") throw new Error("A completed MiniMax H3 768p tool job is required.");
    const resultId = input.resultId ?? source.selectedResultId;
    const result = source.results?.find((candidate) => candidate.id === resultId && candidate.type === "video");
    if (!result?.url) throw new Error("Select an available 768p video result before regeneration.");
    const duration = Number(source.request.parameters?.duration ?? 5);
    const prompt = String(source.request.parameters?.prompt ?? "").trim();
    if (!prompt) throw new Error("The original H3 context prompt is unavailable.");
    const stableKey = `${source.id}:${result.id}:${input.idempotencyKey ?? "selected-2k"}`;
    const id = `regen_${createHash("sha256").update(stableKey).digest("hex").slice(0, 32)}`;
    const pending = this.creationLocks.get(id);
    if (pending) return clone(await pending);
    const creation = this.createOnce({ id, stableKey, source, resultId: result.id, resultUrl: result.url, duration, prompt });
    this.creationLocks.set(id, creation);
    try { return clone(await creation); } finally { this.creationLocks.delete(id); }
  }

  private async createOnce(input: { id: string; stableKey: string; source: NonNullable<Awaited<ReturnType<PortableToolJobService["get"]>>>; resultId: string; resultUrl: string; duration: number; prompt: string }): Promise<H3RegenerationJob> {
    const { id, stableKey, source, resultId, resultUrl, duration, prompt } = input;
    const existing = await this.get(id);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const job: H3RegenerationJob = { id, sourceToolJobId: source.id, sourceResultId: resultId, sourceContext: source.request.sourceContext, status: "queued", progress: 0, quote: estimateH3Regeneration(duration), idempotencyKey: stableKey, createdAt: timestamp, updatedAt: timestamp };
    this.jobs.set(id, job);
    await this.persist(job);
    void this.run(job, prompt, resultUrl);
    return clone(job);
  }

  async get(id: string): Promise<H3RegenerationJob | null> {
    if (!/^regen_[a-f0-9]{32}$/.test(id)) return null;
    const cached = this.jobs.get(id);
    if (cached) return clone(cached);
    try { const job = JSON.parse(await readFile(this.path(id), "utf8")) as H3RegenerationJob; if (!["completed", "failed", "cancelled"].includes(job.status)) { job.status = "failed"; job.error = "SnarkRoute restarted before regeneration completed. Retry the action."; job.completedAt = job.updatedAt = new Date().toISOString(); await this.persist(job); } this.jobs.set(id, job); return clone(job); } catch { return null; }
  }

  async cancel(id: string): Promise<H3RegenerationJob | null> {
    await this.get(id);
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!["completed", "failed", "cancelled"].includes(job.status)) { job.status = "cancelled"; job.progress = 0; job.completedAt = job.updatedAt = new Date().toISOString(); await this.persist(job); }
    return clone(job);
  }

  private async run(job: H3RegenerationJob, prompt: string, resultUrl: string) {
    try {
      job.status = "regenerating_2k"; job.progress = 0.1; await this.persist(job);
      const source = await localResultBytes(resultUrl);
      if (this.isCancelled(job.id)) return;
      const provider = await this.client.run({ prompt, baseVideo: source, idempotencyKey: job.id });
      job.providerJobId = provider.id;
      if (this.isCancelled(job.id)) return;
      job.status = "downloading"; job.progress = 0.9; await this.persist(job);
      const bytes = Buffer.from(await this.client.download(provider.url));
      if (this.isCancelled(job.id)) return;
      const outputDirectory = resolve(this.directory, job.id);
      await mkdir(outputDirectory, { recursive: true });
      const filename = `${job.id}.mp4`, path = resolve(outputDirectory, filename);
      await writeFile(path, bytes);
      job.result = { type: "video", filename, url: `/api/assets/preview?kind=video&path=${encodeURIComponent(path)}` };
      job.status = "completed"; job.progress = 1; job.costs = job.quote; job.completedAt = new Date().toISOString();
    } catch (error) {
      if (job.status === "cancelled") return;
      job.status = "failed"; job.progress = 0; job.error = errorMessage(error); job.completedAt = new Date().toISOString();
      delete job.costs;
    }
    await this.persist(job);
  }

  private async persist(job: H3RegenerationJob) { job.updatedAt = new Date().toISOString(); await mkdir(resolve(this.directory, job.id), { recursive: true }); await writeFile(this.path(job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8"); }
  private isCancelled(id: string) { return this.jobs.get(id)?.status === "cancelled"; }
  private path(id: string) { if (!/^regen_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid regeneration job id."); return resolve(this.directory, id, "job.json"); }
}

export const h3RegenerationService = new H3RegenerationService();

async function localResultBytes(url: string) {
  const parsed = new URL(url, "http://snarkroute.local");
  if (parsed.pathname !== "/api/assets/preview") throw new Error("The selected 768p result is not a local SnarkRoute asset.");
  const candidate = parsed.searchParams.get("path") ?? "";
  if (!isAbsolute(candidate)) throw new Error("The selected 768p result path is invalid.");
  const dataRoot = resolve(process.cwd(), "data"), path = resolve(candidate), relation = relative(dataRoot, path);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("The selected 768p result is outside SnarkRoute data storage.");
  const details = await stat(path), limit = positiveEnv("MINIMAX_H3_REGEN_MAX_BASE_VIDEO_BYTES", 100 * 1024 * 1024);
  if (!details.isFile() || details.size <= 0 || details.size > limit || !/\.mp4$/i.test(path)) throw new Error("The selected 768p result is not a valid MP4 within the configured size limit.");
  return readFile(path);
}
function positiveEnv(name: string, fallback: number) { const value = Number(process.env[name]); return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
