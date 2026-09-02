import type { FastifyInstance } from "fastify";
import { h3StudioDirectory } from "../server-paths";
import { deleteEnvValue, writeEnvValue } from "../services/env";
import { errorMessage } from "../services/errors";
import { inspectH3Connection, normalizeH3WorkerUrl } from "../services/h3-connection";
import { H3QueueService, H3_QUEUE_OPERATIONS, type H3QueueAsset, type H3QueueOperation, type H3SessionMode } from "../services/h3-queue";
import { createDefaultH3QueueRuntime, h3VastConfigStatus } from "../services/h3-session-runtime";

const h3QueueService = new H3QueueService({ directory: h3StudioDirectory, runtime: createDefaultH3QueueRuntime() });

export async function registerH3Routes(app: FastifyInstance) {
  app.get("/api/h3/connection", async () => inspectH3Connection());

  app.get("/api/h3/queue", async () => ({ ...(await h3QueueService.getState()), vast: h3VastConfigStatus() }));

  app.post<{ Body: H3QueueItemBody }>("/api/h3/queue", async (request, reply) => {
    try {
      const operation = operationValue(request.body?.operation);
      return reply.code(201).send(await h3QueueService.create({
        title: request.body?.title ?? "",
        operation,
        prompt: promptText(request.body),
        ...(promptJson(request.body?.promptJson) ? { promptJson: promptJson(request.body?.promptJson)! } : {}),
        duration: request.body?.duration,
        aspectRatio: request.body?.aspectRatio,
        seed: request.body?.seed,
        variants: request.body?.variants,
        renderMode: request.body?.renderMode,
        inferenceSteps: request.body?.inferenceSteps,
        assets: Array.isArray(request.body?.assets) ? request.body.assets : []
      }));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<H3QueueItemBody> }>("/api/h3/queue/:id", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const updated = await h3QueueService.update(request.params.id, {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.operation === undefined ? {} : { operation: operationValue(body.operation) }),
        ...(body.prompt === undefined && body.promptJson === undefined ? {} : { prompt: promptText(body as H3QueueItemBody) }),
        ...(body.promptJson === undefined ? {} : { promptJson: promptJson(body.promptJson) }),
        ...(body.duration === undefined ? {} : { duration: body.duration }),
        ...(body.aspectRatio === undefined ? {} : { aspectRatio: body.aspectRatio }),
        ...(body.seed === undefined ? {} : { seed: body.seed }),
        ...(body.variants === undefined ? {} : { variants: body.variants }),
        ...(body.renderMode === undefined ? {} : { renderMode: body.renderMode }),
        ...(body.inferenceSteps === undefined ? {} : { inferenceSteps: body.inferenceSteps }),
        ...(body.assets === undefined ? {} : { assets: body.assets })
      });
      if (!updated) return reply.code(404).send({ error: "H3 queue item not found." });
      return updated;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/h3/queue/:id", async (request, reply) => {
    try {
      if (!await h3QueueService.remove(request.params.id)) return reply.code(404).send({ error: "H3 queue item not found." });
      return reply.code(204).send();
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { direction?: "up" | "down" } }>("/api/h3/queue/:id/move", async (request) => h3QueueService.move(request.params.id, request.body?.direction === "up" ? -1 : 1));
  app.post("/api/h3/queue/clear-finished", async () => h3QueueService.clearFinished());

  app.post<{ Body: { mode?: H3SessionMode } }>("/api/h3/queue/session", async (request, reply) => {
    try {
      const mode = request.body?.mode === "vast" ? "vast" : "saved_worker";
      return reply.code(202).send({ session: await h3QueueService.start(mode) });
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/h3/queue/session/cleanup", async (_request, reply) => {
    try { return { session: await h3QueueService.retryCleanup() }; }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });

  app.get("/api/h3/vast", async () => h3VastConfigStatus());
  app.post<{ Body: H3VastConfigBody }>("/api/h3/vast", async (request, reply) => {
    try {
      const values: Array<[string, string | undefined, (value: string) => void]> = [
        ["VAST_API_KEY", request.body?.apiKey, validateSecret],
        ["HF_TOKEN", request.body?.hfToken, validateSecret],
        ["H3_WORKER_SERVICE_TOKEN", request.body?.serviceToken, validateSecret],
        ["H3_VAST_TEMPLATE_HASH", request.body?.templateHash, validateTemplateHash],
        ["H3_VAST_WORKER_URL_TEMPLATE", request.body?.workerUrlTemplate, validateWorkerUrlTemplate]
      ];
      for (const [key, raw, validate] of values) {
        const value = raw?.trim();
        if (!value) continue;
        validate(value);
        await writeEnvValue(key, value);
        process.env[key] = value;
      }
      if (request.body?.maxHourlyUsd !== undefined) {
        const maximum = Number(request.body.maxHourlyUsd);
        if (!Number.isFinite(maximum) || maximum <= 0 || maximum > 20) throw new Error("Vast hourly ceiling must be between 0 and 20 USD.");
        await writeEnvValue("H3_VAST_MAX_HOURLY_USD", String(maximum));
        process.env.H3_VAST_MAX_HOURLY_USD = String(maximum);
      }
      if (Array.isArray(request.body?.excludedCountryCodes)) {
        const codes = request.body.excludedCountryCodes.map((value) => String(value).trim().toUpperCase()).filter((value) => /^[A-Z]{2}$/.test(value));
        if (!codes.length) throw new Error("At least one valid excluded country code is required.");
        const value = [...new Set(codes)].join(",");
        await writeEnvValue("H3_VAST_EXCLUDED_COUNTRIES", value);
        process.env.H3_VAST_EXCLUDED_COUNTRIES = value;
      }
      return { ok: true, status: h3VastConfigStatus() };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { workerUrl?: string; serviceToken?: string } }>("/api/h3/connection", async (request, reply) => {
    try {
      const workerUrl = normalizeH3WorkerUrl(request.body?.workerUrl ?? "");
      const serviceToken = request.body?.serviceToken?.trim() ?? "";
      if (!workerUrl || !serviceToken) return reply.code(400).send({ error: "H3 worker URL and service token are required." });
      if (!/^[\x21-\x7E]+$/.test(serviceToken)) return reply.code(400).send({ error: "H3 service token cannot contain whitespace or non-ASCII characters." });

      const status = await inspectH3Connection({ workerUrl, serviceToken });
      if (!status.connected || !status.ready) return reply.code(400).send({ error: status.error ?? status.reason ?? "H3 worker is not ready.", status });

      await writeEnvValue("H3_WORKER_URL", workerUrl);
      await writeEnvValue("H3_WORKER_SERVICE_TOKEN", serviceToken);
      process.env.H3_WORKER_URL = workerUrl;
      process.env.H3_WORKER_SERVICE_TOKEN = serviceToken;
      return { ok: true, status };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete("/api/h3/connection", async (_request, reply) => {
    try {
      await deleteEnvValue("H3_WORKER_URL");
      await deleteEnvValue("H3_WORKER_SERVICE_TOKEN");
      delete process.env.H3_WORKER_URL;
      delete process.env.H3_WORKER_SERVICE_TOKEN;
      return { ok: true, status: await inspectH3Connection() };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });
}

type H3QueueItemBody = {
  title?: string;
  operation?: H3QueueOperation;
  prompt?: string;
  promptJson?: unknown;
  duration?: number;
  aspectRatio?: string;
  seed?: number;
  variants?: number;
  renderMode?: "preview" | "final";
  inferenceSteps?: number;
  assets?: H3QueueAsset[];
};

type H3VastConfigBody = {
  apiKey?: string;
  hfToken?: string;
  serviceToken?: string;
  templateHash?: string;
  workerUrlTemplate?: string;
  maxHourlyUsd?: number;
  excludedCountryCodes?: string[];
};

function operationValue(value: unknown): H3QueueOperation {
  if (typeof value !== "string" || !H3_QUEUE_OPERATIONS.includes(value as H3QueueOperation)) throw new Error("Choose a supported H3 queue operation.");
  return value as H3QueueOperation;
}

function promptJson(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("H3 JSON prompt must be an object.");
  return parsed as Record<string, unknown>;
}

function promptText(body: H3QueueItemBody): string {
  const explicit = body.prompt?.trim();
  if (explicit) return explicit;
  const structured = promptJson(body.promptJson);
  if (!structured) return "";
  return JSON.stringify(structured);
}

function validateSecret(value: string): void { if (!/^[\x21-\x7E]+$/.test(value)) throw new Error("Provider secrets cannot contain whitespace or non-ASCII characters."); }
function validateTemplateHash(value: string): void { if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new Error("Vast template hash is invalid."); }
function validateWorkerUrlTemplate(value: string): void {
  if (!value.startsWith("https://")) throw new Error("Managed Vast worker URL template must use HTTPS.");
  const sample = value.replace(/\{instance_id\}/g, "1").replace(/\{public_ipaddr\}/g, "203.0.113.10").replace(/\{ssh_host\}/g, "ssh.example.test").replace(/\{ssh_port\}/g, "22");
  normalizeH3WorkerUrl(sample);
}
