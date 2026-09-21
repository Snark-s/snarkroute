import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { createH3WorkerClient, type H3ModelVariant } from "@snarkroute/h3";
import { h3StudioDirectory } from "../server-paths";
import { deleteEnvValue, writeEnvValue } from "../services/env";
import { errorMessage } from "../services/errors";
import { inspectH3Connection, normalizeH3WorkerUrl } from "../services/h3-connection";
import { h3LocalWslStatus, startH3LocalWsl, stopH3LocalWsl } from "../services/h3-local-wsl";
import { H3QueueService, H3_QUEUE_OPERATIONS, type H3QueueAsset, type H3QueueOperation, type H3SessionMode } from "../services/h3-queue";
import { createDefaultH3QueueRuntime, h3VastConfigStatus } from "../services/h3-session-runtime";
import { createH3VastTemplate } from "../services/h3-vast-template";

const h3QueueService = new H3QueueService({ directory: h3StudioDirectory, runtime: createDefaultH3QueueRuntime() });

export async function registerH3Routes(app: FastifyInstance) {
  app.get("/api/h3/connection", async () => {
    const status = await inspectH3Connection();
    return { ...status, local: h3LocalWslStatus(status) };
  });

  app.post("/api/h3/local/start", async (_request, reply) => {
    try {
      const started = await startH3LocalWsl();
      await writeEnvValue("H3_WORKER_URL", started.status.workerUrl);
      await writeEnvValue("H3_WORKER_SERVICE_TOKEN", started.serviceToken);
      process.env.H3_WORKER_URL = started.status.workerUrl;
      process.env.H3_WORKER_SERVICE_TOKEN = started.serviceToken;
      return { ok: true, status: { ...started.status, local: started.local } };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/h3/local/stop", async (_request, reply) => {
    try {
      const local = await stopH3LocalWsl();
      const status = await inspectH3Connection();
      return { ok: true, status: { ...status, local } };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/h3/queue", async () => ({ ...(await h3QueueService.getState()), vast: h3VastConfigStatus() }));

  app.get("/api/h3/models", async (_request, reply) => {
    try {
      return await h3Client().models();
    } catch (error) {
      return reply.code(503).send({ error: errorMessage(error), models: [] });
    }
  });

  app.post<{ Params: { variant: H3ModelVariant } }>("/api/h3/models/:variant/download", async (request, reply) => {
    try {
      return reply.code(202).send(await h3Client().downloadModel(request.params.variant));
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

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
        modelVariant: request.body?.modelVariant,
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
        ...(body.modelVariant === undefined ? {} : { modelVariant: body.modelVariant }),
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
  app.post<{ Params: { id: string }; Body: { selected?: boolean } }>("/api/h3/queue/:id/selection", async (request, reply) => {
    try {
      const item = await h3QueueService.setSelected(request.params.id, request.body?.selected === true);
      return item ?? reply.code(404).send({ error: "H3 queue item not found." });
    } catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/h3/queue/:id/archive", async (request, reply) => {
    try {
      const item = await h3QueueService.archive(request.params.id);
      return item ?? reply.code(404).send({ error: "H3 queue item not found." });
    } catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  app.post<{ Params: { id: string } }>("/api/h3/queue/:id/restore", async (request, reply) => {
    try {
      const item = await h3QueueService.restore(request.params.id);
      return item ?? reply.code(404).send({ error: "H3 queue item not found." });
    } catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  app.post("/api/h3/queue/clear-finished", async () => h3QueueService.clearFinished());

  app.post("/api/h3/results/trash-orphans", async (_request, reply) => {
    try { return await h3QueueService.collectOrphanResults(); }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });
  app.post("/api/h3/results/empty-trash", async (_request, reply) => {
    try { return await h3QueueService.emptyTrash(); }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });

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
        ["H3_VAST_WORKER_URL_TEMPLATE", request.body?.workerUrlTemplate, validateWorkerUrlTemplate],
        ["H3_VAST_SSH_PRIVATE_KEY", request.body?.sshPrivateKeyPath, validateLocalPath]
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
      if (!process.env.H3_WORKER_SERVICE_TOKEN?.trim()) {
        const serviceToken = randomBytes(32).toString("hex");
        await writeEnvValue("H3_WORKER_SERVICE_TOKEN", serviceToken);
        process.env.H3_WORKER_SERVICE_TOKEN = serviceToken;
      }
      if (request.body?.acceptLicense === true) {
        await writeEnvValue("H3_ACCEPT_MODEL_LICENSE", "1");
        process.env.H3_ACCEPT_MODEL_LICENSE = "1";
      }
      await writeEnvValue("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
      process.env.H3_VAST_CONNECTION_MODE = "ssh_tunnel";
      return { ok: true, status: h3VastConfigStatus() };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/h3/queue/session/cancel", async (_request, reply) => {
    try { return { session: await h3QueueService.cancelActive() }; }
    catch (error) { return reply.code(409).send({ error: errorMessage(error) }); }
  });

  app.post<{ Body: { path?: string; mode?: "open" | "folder" } }>("/api/h3/results/open", async (request, reply) => {
    try {
      const path = await h3ResultPath(request.body?.path);
      const child = request.body?.mode === "folder"
        ? spawn("explorer.exe", ["/select,", path], { detached: true, stdio: "ignore", windowsHide: false })
        : spawn("rundll32.exe", ["url.dll,FileProtocolHandler", path], { detached: true, stdio: "ignore", windowsHide: false });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      child.unref();
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/h3/vast/template", async (_request, reply) => {
    try {
      const before = h3VastConfigStatus();
      if (!before.apiKeyConfigured) throw new Error("Save the Vast API key first.");
      if (!before.hfTokenConfigured) throw new Error("Save the Hugging Face token first.");
      if (!before.licenseAccepted) throw new Error("Accept the pinned MiniMax H3 model license first.");
      if (!before.sshKeyConfigured) throw new Error("No local SSH private key was found. Select the key used by Vast first.");
      const template = await createH3VastTemplate(process.env.VAST_API_KEY!);
      await writeEnvValue("H3_VAST_TEMPLATE_HASH", template.hashId);
      process.env.H3_VAST_TEMPLATE_HASH = template.hashId;
      await writeEnvValue("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
      process.env.H3_VAST_CONNECTION_MODE = "ssh_tunnel";
      return { ok: true, template, status: h3VastConfigStatus() };
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
  modelVariant?: "h3_base" | "10eros_max" | "10eros_max_turbo";
  inferenceSteps?: number;
  assets?: H3QueueAsset[];
};

type H3VastConfigBody = {
  apiKey?: string;
  hfToken?: string;
  serviceToken?: string;
  templateHash?: string;
  workerUrlTemplate?: string;
  sshPrivateKeyPath?: string;
  maxHourlyUsd?: number;
  excludedCountryCodes?: string[];
  acceptLicense?: boolean;
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

function h3Client() {
  return createH3WorkerClient({
    baseUrl: process.env.H3_WORKER_URL,
    serviceToken: process.env.H3_WORKER_SERVICE_TOKEN,
    timeoutMs: 30_000,
  });
}

async function h3ResultPath(value: string | undefined): Promise<string> {
  if (!value) throw new Error("Result path is required.");
  const root = resolve(join(h3StudioDirectory, "results"));
  const path = resolve(value);
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error("Only generated H3 result files can be opened.");
  }
  await access(path);
  return path;
}
function validateLocalPath(value: string): void {
  if (value.includes("\0") || value.length > 1_024) throw new Error("SSH private key path is invalid.");
}
