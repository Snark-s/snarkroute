import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunResult } from "@snarkroute/executor";
import type { OpenRoute } from "@snarkroute/protocol";
import { createRouteExecutor } from "../execution/service";
import { modelGatewayJobsDirectory } from "../server-paths";
import { errorMessage } from "../services/errors";

export type GenerationJobStatus = "queued" | "running" | "completed" | "failed";

export type GenerationJobRequest = {
  capability: "video.generate";
  nodeType: "polza.video.generate";
  modelId: string;
  provider: string;
  prompt: string;
  parameters?: Record<string, unknown>;
  inputs?: Array<{ kind: "image"; path: string }>;
};

export type GenerationJob = {
  id: string;
  status: GenerationJobStatus;
  request: GenerationJobRequest;
  createdAt: string;
  updatedAt: string;
  result?: {
    path: string;
    filename: string;
    mimeType: string;
    provider: string | null;
    modelId: string;
    estimatedCost: number | null;
    actualCost: number | null;
  };
  error?: string;
};

type ExecuteJob = (job: GenerationJob, outputDirectory: string) => Promise<RunResult>;

export class ModelGatewayJobService {
  private readonly jobs = new Map<string, GenerationJob>();

  constructor(
    private readonly directory = modelGatewayJobsDirectory,
    private readonly execute: ExecuteJob = executeGenerationJob
  ) {}

  async create(request: GenerationJobRequest): Promise<GenerationJob> {
    validateRequest(request);
    const now = new Date().toISOString();
    const job: GenerationJob = { id: `gen_${randomUUID()}`, status: "queued", request: sanitizeRequest(request), createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    await this.persist(job);
    void this.run(job.id);
    return publicJob(job);
  }

  async get(id: string): Promise<GenerationJob | null> {
    const cached = this.jobs.get(id);
    if (cached) return publicJob(cached);
    try {
      const parsed = JSON.parse(await readFile(this.jobPath(id), "utf8")) as GenerationJob;
      if (parsed.status === "queued" || parsed.status === "running") {
        parsed.status = "failed";
        parsed.error = "SnarkRoute server restarted before this job completed. Start the generation again.";
        parsed.updatedAt = new Date().toISOString();
        await this.persist(parsed);
      }
      this.jobs.set(id, parsed);
      return publicJob(parsed);
    } catch {
      return null;
    }
  }

  resultStream(job: GenerationJob) {
    if (job.status !== "completed" || !job.result?.path) throw new Error("Generation result is not ready.");
    return createReadStream(job.result.path);
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
    try {
      const outputDirectory = join(this.directory, job.id, "run");
      const result = await this.execute(job, outputDirectory);
      if (result.status !== "succeeded") throw new Error(result.nodeResults.generate?.error ?? "Generation failed.");
      job.result = resultFromRun(result, job);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = errorMessage(error);
    }
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
  }

  private async persist(job: GenerationJob): Promise<void> {
    await mkdir(join(this.directory, job.id), { recursive: true });
    await writeFile(this.jobPath(job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  private jobPath(id: string): string {
    if (!/^gen_[a-f0-9-]+$/i.test(id)) throw new Error("Invalid generation job id.");
    return join(this.directory, id, "job.json");
  }
}

export const modelGatewayJobService = new ModelGatewayJobService();

async function executeGenerationJob(job: GenerationJob, outputDirectory: string): Promise<RunResult> {
  const executor = await createRouteExecutor();
  const route: OpenRoute = {
    routeVersion: "0.1",
    route: { id: `after-effects-${job.id}`, title: "After Effects Video Generation", author: { name: "SnarkRoute After Effects" } },
    nodes: [{
      id: "generate",
      type: job.request.nodeType,
      params: {
        ...(job.request.parameters ?? {}),
        model: job.request.modelId,
        prompt: job.request.prompt,
        images: (job.request.inputs ?? []).filter((input) => input.kind === "image").map((input) => ({ path: input.path, localPath: input.path }))
      }
    }],
    edges: []
  };
  return executor.executeRoute(route, { runId: job.id, outputDirectory });
}

function validateRequest(request: GenerationJobRequest): void {
  if (request.capability !== "video.generate") throw new Error("Only video.generate is supported by the first After Effects vertical slice.");
  if (request.nodeType !== "polza.video.generate" || request.provider !== "polza") throw new Error("The selected model is not executable through the current video generation node.");
  if (!request.modelId?.trim()) throw new Error("modelId is required.");
  if (!request.prompt?.trim()) throw new Error("prompt is required.");
  for (const input of request.inputs ?? []) if (input.kind !== "image" || !input.path?.trim()) throw new Error("Each input must be a local image asset path.");
}

function sanitizeRequest(request: GenerationJobRequest): GenerationJobRequest {
  const parameters = Object.fromEntries(Object.entries(request.parameters ?? {}).filter(([key]) => !/api[_-]?key|token|secret|password/i.test(key)));
  return { ...request, modelId: request.modelId.trim(), prompt: request.prompt.trim(), parameters, inputs: request.inputs ?? [] };
}

function resultFromRun(run: RunResult, job: GenerationJob): NonNullable<GenerationJob["result"]> {
  const output = objectRecord(run.nodeResults.generate?.output);
  const video = objectRecord(output.video);
  const path = stringValue(video.localPath) ?? stringValue(video.path);
  if (!path || /^https?:\/\//i.test(path)) throw new Error("Generation completed without a local video result.");
  return {
    path,
    filename: stringValue(video.filename) ?? basename(path),
    mimeType: stringValue(video.mimeType) ?? "video/mp4",
    provider: stringValue(output.provider) ?? null,
    modelId: stringValue(output.model) ?? job.request.modelId,
    estimatedCost: numberValue(output.estimatedCost),
    actualCost: numberValue(output.actualCost)
  };
}

function publicJob(job: GenerationJob): GenerationJob {
  return JSON.parse(JSON.stringify(job)) as GenerationJob;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
