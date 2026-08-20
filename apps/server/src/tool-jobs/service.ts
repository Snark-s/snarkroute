import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getLocalAssetMetadata, type PortableToolField, type PortableToolSchema } from "@snarkroute/nodes";
import { runCanvasActionSession } from "../libraries/service";
import { assetsDirectory, modelGatewayJobsDirectory } from "../server-paths";
import { errorMessage } from "../services/errors";
import { publishedTool } from "../tools/catalog";

type PublishedToolEntry = Awaited<ReturnType<typeof publishedTool>>;
type ResolveTool = (id: string) => Promise<PublishedToolEntry>;
type RunToolAction = typeof runCanvasActionSession;

export type PortableToolJobStatus = "queued" | "starting_provider" | "loading_model" | "generating" | "generating_768p" | "regenerating_2k" | "downloading" | "completed" | "failed" | "cancelled";
export type PortableToolJobInput = { type: "image" | "video" | "audio" | "text"; text?: string; assetId?: string; path?: string; filename?: string; mimeType?: string };
export type PortableToolJobRequest = {
  toolId: string;
  schemaVersion: string;
  hostType: "boojumroute" | "after_effects" | "photoshop";
  inputs?: Record<string, PortableToolJobInput>;
  parameters?: Record<string, unknown>;
  sourceContext?: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
};
export type PortableToolJob = {
  id: string;
  status: PortableToolJobStatus;
  progress: number;
  request: PortableToolJobRequest;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  results?: Array<{ id: string; outputId: string; type: "image" | "video" | "audio" | "text"; label: string; text?: string; url?: string; filename?: string }>;
  selectedResultId?: string;
  error?: string;
};

export class PortableToolJobService {
  private readonly jobs = new Map<string, PortableToolJob>();
  private readonly idempotency = new Map<string, string>();

  constructor(
    private readonly directory = `${modelGatewayJobsDirectory}-tools`,
    private readonly resolveTool: ResolveTool = publishedTool,
    private readonly runToolAction: RunToolAction = runCanvasActionSession
  ) {}

  async create(request: PortableToolJobRequest): Promise<PortableToolJob> {
    const entry = await this.resolveTool(request.toolId);
    if (!entry) throw new Error(`Published tool "${request.toolId}" was not found.`);
    validateRequest(entry.tool, request);
    const sanitized = sanitizeRequest(request);
    if (sanitized.idempotencyKey) {
      const existing = this.idempotency.get(sanitized.idempotencyKey);
      if (existing) return this.get(existing) as Promise<PortableToolJob>;
    }
    const now = new Date().toISOString();
    const job: PortableToolJob = { id: `tool_${randomUUID()}`, status: "queued", progress: 0, request: sanitized, createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job);
    if (sanitized.idempotencyKey) this.idempotency.set(sanitized.idempotencyKey, job.id);
    await this.persist(job);
    void this.run(job.id, entry.tool);
    return clone(job);
  }

  async get(id: string): Promise<PortableToolJob | null> {
    const cached = this.jobs.get(id);
    if (cached) return clone(cached);
    if (!/^tool_[a-f0-9-]+$/i.test(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(this.path(id), "utf8")) as PortableToolJob;
      if (!["completed", "failed", "cancelled"].includes(parsed.status)) {
        parsed.status = "failed";
        parsed.error = "SnarkRoute restarted before this tool job completed. Retry the tool.";
        parsed.updatedAt = new Date().toISOString();
        parsed.completedAt = parsed.updatedAt;
        await this.persist(parsed);
      }
      this.jobs.set(id, parsed);
      if (parsed.request.idempotencyKey) this.idempotency.set(parsed.request.idempotencyKey, id);
      return clone(parsed);
    } catch { return null; }
  }

  async cancel(id: string): Promise<PortableToolJob | null> {
    await this.get(id);
    const job = this.jobs.get(id);
    if (!job) return null;
    if (["completed", "failed", "cancelled"].includes(job.status)) return clone(job);
    const now = new Date().toISOString();
    job.status = "cancelled";
    job.cancelRequestedAt = now;
    job.completedAt = now;
    job.updatedAt = now;
    await this.persist(job);
    return clone(job);
  }

  async select(id: string, resultId: string): Promise<PortableToolJob | null> {
    await this.get(id);
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "completed" || !job.results?.some((result) => result.id === resultId)) throw new Error("The selected tool result is unavailable.");
    job.selectedResultId = resultId;
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
    return clone(job);
  }

  private async run(id: string, tool: PortableToolSchema): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    try {
      if (tool.action.kind !== "node") throw new Error("Endpoint-backed portable tools require a dedicated server adapter.");
      await this.transition(job, "starting_provider", 0.05);
      const inputs = Object.fromEntries(await Promise.all(tool.inputs.map(async (field) => [field.id, await sessionInput(field, job.request.inputs?.[field.id])] as const)));
      if (this.jobs.get(id)?.status === "cancelled") return;
      await this.transition(job, tool.id === "minimax.h3.generate" ? "generating_768p" : "generating", 0.15);
      const result = await this.runToolAction({ sessionId: id, actionId: tool.action.value, inputs, params: job.request.parameters, surface: "portable" });
      if (this.jobs.get(id)?.status === "cancelled") return;
      await this.transition(job, "downloading", 0.9);
      job.results = result.results.map(({ value: _value, ...output }) => output);
      job.status = "completed";
      job.progress = 1;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      if (this.jobs.get(id)?.status === "cancelled") return;
      job.status = "failed";
      job.error = errorMessage(error);
      job.completedAt = new Date().toISOString();
    }
    job.updatedAt = new Date().toISOString();
    await this.persist(job);
  }

  private async transition(job: PortableToolJob, status: PortableToolJobStatus, progress: number) {
    if (job.status === "cancelled") return;
    const now = new Date().toISOString();
    job.status = status;
    job.progress = progress;
    job.updatedAt = now;
    job.startedAt ??= now;
    await this.persist(job);
  }

  private async persist(job: PortableToolJob) {
    await mkdir(resolve(this.directory, job.id), { recursive: true });
    await writeFile(this.path(job.id), `${JSON.stringify(job, null, 2)}\n`, "utf8");
  }

  private path(id: string) {
    if (!/^tool_[a-f0-9-]+$/i.test(id)) throw new Error("Invalid portable tool job id.");
    return resolve(this.directory, id, "job.json");
  }
}

export const portableToolJobService = new PortableToolJobService();

function validateRequest(tool: PortableToolSchema, request: PortableToolJobRequest) {
  if (request.schemaVersion !== tool.schemaVersion) throw new Error(`Tool schema version ${request.schemaVersion} is not current.`);
  if (!tool.hosts.some((contract) => contract.host === request.hostType)) throw new Error(`Tool does not support host ${request.hostType}.`);
  const allowedParams = new Set((tool.params ?? []).map((field) => field.id));
  for (const id of Object.keys(request.parameters ?? {})) if (!allowedParams.has(id)) throw new Error(`Unknown tool parameter "${id}".`);
  for (const field of tool.params ?? []) validateFieldValue(field, request.parameters?.[field.id]);
  for (const field of tool.inputs) {
    const value = request.inputs?.[field.id];
    if (field.required && !value) throw new Error(`Tool input "${field.id}" is required.`);
    if (value && value.type !== mediaType(field.type)) throw new Error(`Tool input "${field.id}" expects ${mediaType(field.type)}.`);
  }
  if (Object.keys(request.inputs ?? {}).some((id) => !tool.inputs.some((field) => field.id === id))) throw new Error("Request contains an undeclared tool input.");
  assertJsonLimit(request.parameters, 64 * 1024, "parameters");
  assertJsonLimit(request.sourceContext, 64 * 1024, "sourceContext");
  if (request.idempotencyKey && !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(request.idempotencyKey)) throw new Error("idempotencyKey is invalid.");
}

function validateFieldValue(field: PortableToolField, value: unknown) {
  const actual = value ?? field.default;
  if (field.required && (actual === undefined || actual === null || actual === "")) throw new Error(`Tool parameter "${field.id}" is required.`);
  if (actual === undefined) return;
  if (["number", "integer", "seed", "duration"].includes(field.type) && (typeof actual !== "number" || !Number.isFinite(actual))) throw new Error(`Tool parameter "${field.id}" must be numeric.`);
  if ((field.type === "integer" || field.type === "seed") && !Number.isInteger(actual)) throw new Error(`Tool parameter "${field.id}" must be an integer.`);
  if (typeof actual === "number" && field.min !== undefined && actual < field.min) throw new Error(`Tool parameter "${field.id}" is below its minimum.`);
  if (typeof actual === "number" && field.max !== undefined && actual > field.max) throw new Error(`Tool parameter "${field.id}" exceeds its maximum.`);
  if (field.type === "select" && !field.options?.some((option) => Object.is(option.value, actual))) throw new Error(`Tool parameter "${field.id}" is not an allowed option.`);
}

async function sessionInput(field: PortableToolField, value?: PortableToolJobInput) {
  if (!value) return undefined as never;
  if (value.type === "text") return { type: "text" as const, text: value.text ?? "" };
  if (!value.assetId || !/^asset_[a-f0-9-]+$/i.test(value.assetId) || !value.path) throw new Error(`Tool input "${field.id}" must reference an imported asset.`);
  const path = safeAssetPath(value.path);
  const details = await stat(path);
  const limit = positiveEnv("SNARKROUTE_TOOL_MAX_INPUT_BYTES", 100 * 1024 * 1024);
  if (!details.isFile() || details.size <= 0 || details.size > limit) throw new Error(`Tool input "${field.id}" has an invalid file size.`);
  const metadata = await getLocalAssetMetadata(path, value.type === "audio" ? "file" : value.type);
  if (field.acceptedMimes?.length && !field.acceptedMimes.some((pattern) => mimeMatches(metadata.mimeType, pattern))) throw new Error(`Tool input "${field.id}" has disallowed MIME type ${metadata.mimeType}.`);
  return { type: value.type, filename: value.filename ?? metadata.filename, mimeType: metadata.mimeType, dataBase64: (await readFile(path)).toString("base64") };
}

function safeAssetPath(candidate: string) {
  if (!isAbsolute(candidate)) throw new Error("Imported asset paths must be absolute.");
  const root = resolve(assetsDirectory);
  const path = resolve(candidate);
  const relation = relative(root, path);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) throw new Error("Tool input path is outside the imported asset directory.");
  return path;
}

function mediaType(type: PortableToolField["type"]): PortableToolJobInput["type"] {
  if (type === "image" || type === "images" || type === "mask" || type === "host_selection" || type === "host_active_layer" || type === "host_current_frame") return "image";
  if (type === "video" || type === "videos" || type === "host_work_area") return "video";
  if (type === "audio") return "audio";
  return "text";
}

function sanitizeRequest(request: PortableToolJobRequest): PortableToolJobRequest {
  return { ...request, parameters: redact(request.parameters ?? {}) as Record<string, unknown>, sourceContext: redact(request.sourceContext ?? {}) as Record<string, unknown> };
}
function redact(value: unknown): unknown { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [/api[_-]?key|token|secret|password/i.test(key) ? [key, "[redacted]"] : [key, redact(nested)]])); }
function assertJsonLimit(value: unknown, limit: number, label: string) { if (value !== undefined && Buffer.byteLength(JSON.stringify(value), "utf8") > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`); }
function mimeMatches(actual: string, pattern: string) { return pattern.endsWith("/*") ? actual.startsWith(pattern.slice(0, -1)) : actual === pattern; }
function positiveEnv(name: string, fallback: number) { const parsed = Number(process.env[name]); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
