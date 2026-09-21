import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createH3WorkerClient, type H3GenerationInput, type H3Reference, type H3WorkerJob } from "@snarkroute/h3";
import { h3StudioDirectory } from "../server-paths";
import { inspectH3Connection, normalizeH3WorkerUrl } from "./h3-connection";
import { H3ManagedInstanceError, H3QueueBlockedError, type H3QueueItem, type H3QueueLease, type H3QueueRuntime, type H3SessionMode } from "./h3-queue";
import { openH3SshTunnel, resolveH3SshPrivateKeyPath, type H3SshTunnel } from "./h3-ssh-tunnel";
import { H3_VAST_IMAGE, H3_VAST_IMAGE_TAG, H3_VAST_SOURCE_REVISION } from "./h3-vast-template";
import { DEFAULT_EXCLUDED_H3_COUNTRIES, selectH3VastOffer, VastClient, type VastInstance } from "./vast-client";

const activeVastTunnels = new Map<number, H3SshTunnel>();

export type H3VastConfigStatus = {
  configured: boolean;
  apiKeyConfigured: boolean;
  templateHashConfigured: boolean;
  workerUrlTemplateConfigured: boolean;
  sshKeyConfigured: boolean;
  hfTokenConfigured: boolean;
  serviceTokenConfigured: boolean;
  licenseAccepted: boolean;
  connectionMode: "ssh_tunnel" | "external_https";
  maxHourlyUsd: number;
  excludedCountryCodes: string[];
  workerUrlTemplate: string;
  sshPrivateKeyPath: string;
  sourceRevision: string;
  image: string;
  reason?: string;
};

export function h3VastConfigStatus(): H3VastConfigStatus {
  const apiKeyConfigured = Boolean(process.env.VAST_API_KEY?.trim());
  const templateHashConfigured = Boolean(process.env.H3_VAST_TEMPLATE_HASH?.trim());
  const workerUrlTemplate = process.env.H3_VAST_WORKER_URL_TEMPLATE?.trim() ?? "";
  const workerUrlTemplateConfigured = Boolean(workerUrlTemplate);
  const connectionMode = process.env.H3_VAST_CONNECTION_MODE === "external_https" ? "external_https" : "ssh_tunnel";
  const sshPrivateKeyPath = resolveH3SshPrivateKeyPath();
  const sshKeyConfigured = Boolean(sshPrivateKeyPath);
  const hfTokenConfigured = Boolean(process.env.HF_TOKEN?.trim());
  const serviceTokenConfigured = Boolean(process.env.H3_WORKER_SERVICE_TOKEN?.trim());
  const licenseAccepted = process.env.H3_ACCEPT_MODEL_LICENSE === "1";
  const maxHourlyUsd = positiveNumber(process.env.H3_VAST_MAX_HOURLY_USD, 1.2);
  const excludedCountryCodes = excludedCountries();
  const transportConfigured = connectionMode === "ssh_tunnel" ? sshKeyConfigured : workerUrlTemplateConfigured;
  const configured = apiKeyConfigured && templateHashConfigured && transportConfigured && hfTokenConfigured && serviceTokenConfigured && licenseAccepted;
  return {
    configured,
    apiKeyConfigured,
    templateHashConfigured,
    workerUrlTemplateConfigured,
    sshKeyConfigured,
    hfTokenConfigured,
    serviceTokenConfigured,
    licenseAccepted,
    connectionMode,
    maxHourlyUsd,
    excludedCountryCodes,
    workerUrlTemplate,
    sshPrivateKeyPath,
    sourceRevision: H3_VAST_SOURCE_REVISION,
    image: `${H3_VAST_IMAGE}:${H3_VAST_IMAGE_TAG}`,
    ...(configured ? {} : { reason: "Vast mode requires an API key, generated template, HF token, accepted model license, H3 service token, and a local SSH private key." })
  };
}

export function createDefaultH3QueueRuntime(options: { fetchImpl?: typeof fetch; resultsDirectory?: string } = {}): H3QueueRuntime {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resultsDirectory = options.resultsDirectory ?? join(h3StudioDirectory, "results");
  return {
    acquire: (mode, onLease) => acquire(mode, onLease, fetchImpl),
    render: (item, lease, onProgress, onJobCreated) => render(item, lease, onProgress, onJobCreated, resultsDirectory, fetchImpl),
    cancel: (item, lease) => cancel(item, lease, fetchImpl),
    cleanup: (lease) => cleanup(lease, fetchImpl)
  };
}

async function acquire(mode: H3SessionMode, onLease: (lease: H3QueueLease) => Promise<void>, fetchImpl: typeof fetch): Promise<H3QueueLease> {
  if (mode === "saved_worker") {
    const status = await inspectH3Connection({ fetchImpl, timeoutMs: 10_000 });
    if (!status.ready) throw new Error(status.error ?? status.reason ?? "The saved H3 worker is not ready.");
    const lease = {
      workerUrl: status.workerUrl,
      serviceToken: requiredEnv("H3_WORKER_SERVICE_TOKEN")
    };
    await onLease(lease);
    return lease;
  }

  const config = h3VastConfigStatus();
  if (!config.configured) throw new Error(config.reason);
  const vast = new VastClient({ apiKey: requiredEnv("VAST_API_KEY"), fetchImpl });
  const offers = await vast.searchH3Offers({ allocatedStorageGb: 300 });
  const offer = selectH3VastOffer(offers, { maxHourlyUsd: config.maxHourlyUsd, excludedCountryCodes: config.excludedCountryCodes });
  if (!offer) throw new Error(`No safe Vast H3 offer is available below $${config.maxHourlyUsd.toFixed(2)}/hour. Nothing was rented.`);

  let instanceId: number | undefined;
  try {
    const created = await vast.createInstance(offer.id, {
      templateHash: requiredEnv("H3_VAST_TEMPLATE_HASH"),
      diskGb: 300,
      label: `SnarkRoute H3 ${new Date().toISOString()}`,
      env: {
        HF_TOKEN: requiredEnv("HF_TOKEN"),
        H3_WORKER_SERVICE_TOKEN: requiredEnv("H3_WORKER_SERVICE_TOKEN"),
        H3_ACCEPT_MODEL_LICENSE: "1",
        H3_SNARKROUTE_REVISION: H3_VAST_SOURCE_REVISION,
        H3_SGLANG_PRECISION_PROFILE: process.env.H3_SGLANG_PRECISION_PROFILE?.trim() || "kitchen_int8"
      }
    });
    instanceId = created.instanceId;
    await onLease({
      workerUrl: "",
      serviceToken: requiredEnv("H3_WORKER_SERVICE_TOKEN"),
      managedInstanceId: instanceId,
      offerId: offer.id,
      hourlyPriceUsd: offer.dph_total
    });
    const instance = await vast.waitUntilRunning(instanceId, {
      timeoutMs: positiveInteger(process.env.H3_VAST_STARTUP_TIMEOUT_MS, 25 * 60_000),
      pollMs: positiveInteger(process.env.H3_VAST_POLL_MS, 10_000)
    });
    const workerUrl = config.connectionMode === "external_https"
      ? resolveWorkerUrl(requiredEnv("H3_VAST_WORKER_URL_TEMPLATE"), instance)
      : await openManagedTunnel(instance);
    await waitForWorker(workerUrl, requiredEnv("H3_WORKER_SERVICE_TOKEN"), fetchImpl);
    return {
      workerUrl,
      serviceToken: requiredEnv("H3_WORKER_SERVICE_TOKEN"),
      managedInstanceId: instanceId,
      offerId: offer.id,
      hourlyPriceUsd: offer.dph_total
    };
  } catch (error) {
    if (!instanceId) throw error;
    await closeManagedTunnel(instanceId);
    try {
      await vast.destroyAndConfirm(instanceId);
    } catch (cleanupError) {
      throw new H3ManagedInstanceError(`${errorMessage(error)} Cleanup also failed: ${errorMessage(cleanupError)}`, instanceId);
    }
    throw error;
  }
}

async function render(item: H3QueueItem, lease: H3QueueLease, onProgress: (progress: number, stage?: string) => Promise<void>, onJobCreated: ((workerJobId: string) => Promise<void>) | undefined, resultsDirectory: string, fetchImpl: typeof fetch) {
  const requiredCapability = capabilityFor(item.operation);
  if (!requiredCapability) throw new H3QueueBlockedError(blockedReason(item.operation));
  const client = createH3WorkerClient({ baseUrl: lease.workerUrl, serviceToken: lease.serviceToken, fetchImpl, pollingIntervalMs: 2_000, timeoutMs: 60 * 60_000 });
  const capabilities = await client.capabilities() as { backend?: string; capabilities?: Array<{ name?: string; available?: boolean; reason?: string }> };
  const capability = capabilities.capabilities?.find((entry) => entry.name === requiredCapability);
  if (!capability?.available) throw new H3QueueBlockedError(capability?.reason ?? `H3 worker does not provide ${requiredCapability}.`);

  const references: H3Reference[] = [];
  for (const asset of item.assets) {
    if (["sourceVideo", "mask"].includes(asset.slot)) continue;
    const uploaded = await client.upload(await readFile(asset.path), asset.filename || basename(asset.path), asset.mimeType);
    references.push({
      kind: asset.kind,
      uri: uploaded.uri,
      role: asset.slot === "firstFrame" ? "firstFrame" : asset.slot === "lastFrame" ? "lastFrame" : "reference",
      ...(item.operation === "style_transfer" && asset.kind === "video" ? { visualMode: "motion" as const } : {})
    });
  }
  validateAssets(item, references);
  const inferenceSteps = inferenceStepsForWorker(item, capabilities.backend);
  const input = generationInputForH3QueueItem(item, references, inferenceSteps);
  let job = await client.create(input, idempotencyKeyForQueueItem(item));
  await onJobCreated?.(job.id);
  const started = Date.now();
  while (!terminal(job.status)) {
    if (Date.now() - started > positiveInteger(process.env.H3_QUEUE_ITEM_TIMEOUT_MS, 60 * 60_000)) throw new Error(`H3 job ${job.id} timed out.`);
    await delay(2_000);
    job = await client.get(job.id);
    await onProgress(typeof job.progress === "number" ? job.progress : 0.05, job.stage);
  }
  if (!successful(job)) throw new Error(workerError(job));

  const itemDirectory = join(resultsDirectory, item.id);
  await mkdir(itemDirectory, { recursive: true });
  const count = Math.max(1, job.outputs?.length ?? item.variants);
  const resultPaths: string[] = [];
  for (let variant = 0; variant < count; variant += 1) {
    const bytes = Buffer.from(await client.download(job.id, variant));
    validateMp4(bytes);
    const path = join(itemDirectory, `${item.id}-${variant}.mp4`);
    await writeFile(path, bytes);
    resultPaths.push(path);
  }
  return { workerJobId: job.id, resultPaths };
}

export function generationInputForH3QueueItem(
  item: Pick<H3QueueItem, "operation" | "prompt" | "duration" | "aspectRatio" | "seed" | "variants" | "renderMode"> & Partial<Pick<H3QueueItem, "modelVariant">>,
  references: H3Reference[],
  inferenceSteps?: number
): H3GenerationInput {
  return {
    prompt: promptForH3QueueItem(item),
    duration: item.duration,
    aspectRatio: item.aspectRatio,
    ...(item.seed === undefined ? {} : { seed: item.seed }),
    variants: item.variants,
    renderMode: item.renderMode,
    modelVariant: item.modelVariant ?? "h3_base",
    ...(inferenceSteps === undefined ? {} : { inferenceSteps }),
    quality: "lossless",
    turboLora: false,
    references
  };
}

async function cancel(item: H3QueueItem, lease: H3QueueLease, fetchImpl: typeof fetch): Promise<void> {
  if (!item.workerJobId) throw new Error("The active H3 worker job id is not available yet.");
  const client = createH3WorkerClient({
    baseUrl: lease.workerUrl,
    serviceToken: lease.serviceToken,
    fetchImpl,
    timeoutMs: 30_000,
  });
  await client.cancel(item.workerJobId);
}

async function cleanup(lease: H3QueueLease, fetchImpl: typeof fetch): Promise<void> {
  if (!lease.managedInstanceId) return;
  const client = new VastClient({ apiKey: requiredEnv("VAST_API_KEY"), fetchImpl });
  try {
    await client.destroyAndConfirm(lease.managedInstanceId);
  } finally {
    await closeManagedTunnel(lease.managedInstanceId);
  }
}

export function idempotencyKeyForQueueItem(
  item: Pick<H3QueueItem, "id" | "operation" | "prompt" | "duration" | "aspectRatio" | "seed" | "variants" | "renderMode" | "inferenceSteps" | "assets" | "startedAt"> & Partial<Pick<H3QueueItem, "modelVariant">>
): string {
  const renderRevision = JSON.stringify({
    attemptStartedAt: item.startedAt,
    operation: item.operation,
    prompt: promptForH3QueueItem(item),
    duration: item.duration,
    aspectRatio: item.aspectRatio,
    seed: item.seed,
    variants: item.variants,
    renderMode: item.renderMode,
    modelVariant: item.modelVariant,
    inferenceSteps: item.inferenceSteps,
    assets: item.assets.map(({ slot, kind, path, filename, mimeType }) => ({
      slot,
      kind,
      path,
      filename,
      mimeType,
    })),
  });
  const revisionHash = createHash("sha256").update(renderRevision).digest("hex").slice(0, 32);
  return `${item.id}:${revisionHash}`;
}

export function promptForH3QueueItem(item: Pick<H3QueueItem, "operation" | "prompt">): string {
  if (item.operation === "style_transfer") {
    const style = styleLanguageForPrompt(item.prompt);
    return [
      "subject_definitions:",
      "<Subject 1> is the visual rendering style abstracted from <Picture 1>. Transfer only its medium, linework, shape language, materials, textures, color palette, contrast and lighting; do not copy its depicted objects or composition.",
      "<Subject 2> is the main subject and environment from <Video 1>. Preserve their identity, anatomy, spatial layout, action and continuity while changing their entire visual rendering.",
      "<Video 1> is a low-detail motion guide derived from the source video for a whole-video style edit. It supplies only subject motion, timing, camera movement, framing and temporal structure; its grayscale rendering must never appear in the result.",
      "",
      "summary:",
      `[video editing + visual style transfer] Redraw the complete source motion as ${style.summary}, while retaining only the action, camera and temporal structure of <Video 1>.`,
      "",
      "retention_analysis:",
      "<Subject 1> (appears throughout [Shot 1]): attribute_transfer - apply the complete visual style from <Picture 1> consistently to the subject, background and every visible element.",
      "<Subject 2> (appears throughout [Shot 1]): fully_preserved - keep the recognizable subject, scene geometry, poses and movement from <Video 1>, but preserve none of its original rendering style.",
      "<Video 1> (appears throughout [Shot 1]): weak_reference - preserve only motion, timing, camera path, framing and scene continuity; discard the guide pixels, colors, textures, materials and lighting.",
      "",
      "detailed_description:",
      `The entire target video has ${style.description} from <Subject 1> in <Picture 1>. This target style is mandatory and more important than preserving the guide's appearance.`,
      `[Shot 1] Recreate the full action and camera movement of <Video 1> with the same subject placement and timing. Redraw every frame from scratch as ${style.artwork}: foreground, subject and background must all use the exact line treatment, illustrated forms, surface texture, palette, contrast and lighting of <Picture 1>. No region may retain a photographic or grayscale guide look. Keep the target style temporally stable without flicker.`,
      `Additional user direction: ${item.prompt}`,
      "",
      "overall_soundscape:",
      "Generate synchronized natural ambience and physical action sounds appropriate to the recreated scene.",
      "",
      "non_diegetic_music:",
      "None unless explicitly requested by the user."
    ].join("\n");
  }
  return item.prompt;
}

function styleLanguageForPrompt(prompt: string): { summary: string; description: string; artwork: string } {
  const explicit = prompt.match(/(?:стиль|style)\s*[:=\-–—]\s*([^\n.!?]+)/iu)?.[1]?.trim();
  if (explicit && /(?:^|\s)(?:аниме|anime)(?:\s|$)/iu.test(explicit)) {
    return {
      summary: "polished colorful anime artwork in <Subject 1>",
      description: "the unmistakable colorful anime illustration style",
      artwork: "polished colorful anime artwork",
    };
  }
  if (explicit) {
    return {
      summary: `polished artwork in the requested “${explicit}” style from <Subject 1>`,
      description: `the unmistakable requested “${explicit}” visual style`,
      artwork: `polished artwork in the requested “${explicit}” style`,
    };
  }
  return {
    summary: "polished artwork in the target style of <Subject 1>",
    description: "the unmistakable target visual style",
    artwork: "polished artwork in the exact target style of <Picture 1>",
  };
}

export function inferenceStepsForWorker(
  item: Pick<H3QueueItem, "renderMode" | "inferenceSteps"> & Partial<Pick<H3QueueItem, "modelVariant">>,
  backend?: string
): number | undefined {
  if (item.inferenceSteps !== undefined) return item.inferenceSteps;
  if (item.modelVariant === "10eros_max") return 8;
  if (item.modelVariant === "10eros_max_turbo") return 6;
  if (backend === "matlow_int8" && item.renderMode === "preview") return 4;
  return undefined;
}

async function openManagedTunnel(instance: VastInstance): Promise<string> {
  const host = String(instance.ssh_host ?? instance.public_ipaddr ?? "");
  const port = Number(instance.ssh_port ?? 0);
  const tunnel = await openH3SshTunnel({
    instanceId: instance.id,
    host,
    port,
    privateKeyPath: process.env.H3_VAST_SSH_PRIVATE_KEY,
    remotePort: positiveInteger(process.env.H3_VAST_REMOTE_WORKER_PORT, 18_080)
  });
  activeVastTunnels.set(instance.id, tunnel);
  return tunnel.workerUrl;
}

async function closeManagedTunnel(instanceId: number): Promise<void> {
  const tunnel = activeVastTunnels.get(instanceId);
  activeVastTunnels.delete(instanceId);
  await tunnel?.close();
}

async function waitForWorker(workerUrl: string, serviceToken: string, fetchImpl: typeof fetch): Promise<void> {
  const started = Date.now();
  const timeoutMs = positiveInteger(process.env.H3_VAST_WORKER_READY_TIMEOUT_MS, 90 * 60_000);
  let lastReason = "worker is not ready";
  while (Date.now() - started < timeoutMs) {
    const status = await inspectH3Connection({ workerUrl, serviceToken, fetchImpl, timeoutMs: 10_000 });
    if (status.ready) return;
    lastReason = status.error ?? status.reason ?? lastReason;
    await delay(10_000);
  }
  throw new Error(`Vast instance is running, but H3 worker readiness timed out: ${lastReason}`);
}

function resolveWorkerUrl(template: string, instance: VastInstance): string {
  const values: Record<string, string> = {
    instance_id: String(instance.id),
    public_ipaddr: String(instance.public_ipaddr ?? ""),
    ssh_host: String(instance.ssh_host ?? ""),
    ssh_port: String(instance.ssh_port ?? "")
  };
  const resolved = template.replace(/\{(instance_id|public_ipaddr|ssh_host|ssh_port)\}/g, (_match, key: string) => values[key] ?? "");
  if (/\{[^}]+\}/.test(resolved)) throw new Error("H3 Vast worker URL template contains an unsupported placeholder.");
  return normalizeH3WorkerUrl(resolved);
}

function capabilityFor(operation: H3QueueItem["operation"]): "fl2va" | "ref2va" | "style_transfer" | null {
  if (operation === "text_to_video" || operation === "first_last_frame") return "fl2va";
  if (operation === "style_transfer") return "style_transfer";
  if (operation === "motion_transfer" || operation === "reference_mix") return "ref2va";
  return null;
}

function blockedReason(operation: H3QueueItem["operation"]): string {
  if (operation === "replace_object") return "Object replacement requires video_inpaint, which the pinned H3 worker does not currently provide.";
  if (operation === "automatic_tracking") return "Automatic tracking is planned but no tracking adapter is configured.";
  return "H3 Regenerate 2K is a separate hosted service and is not part of the local H3 worker session.";
}

function validateAssets(item: H3QueueItem, references: H3Reference[]): void {
  if (item.operation === "first_last_frame" && !references.some((reference) => reference.role === "firstFrame" || reference.role === "lastFrame")) throw new H3QueueBlockedError("First/last-frame generation requires at least one endpoint image.");
  if (item.operation === "style_transfer" && (!references.some((reference) => reference.kind === "video") || !references.some((reference) => reference.kind === "image"))) throw new H3QueueBlockedError("Video style transfer requires both a source video and a style reference image.");
  if ((item.operation === "motion_transfer" || item.operation === "reference_mix") && !references.some((reference) => reference.role === "reference")) throw new H3QueueBlockedError("Reference generation requires at least one image, video, or audio reference.");
}

function validateMp4(bytes: Buffer): void { if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("H3 worker returned a result that is not a valid MP4 file."); }
function terminal(status: H3WorkerJob["status"]): boolean { return ["succeeded", "completed", "failed", "cancelled"].includes(status); }
function successful(job: H3WorkerJob): boolean { return job.status === "succeeded" || job.status === "completed"; }
function workerError(job: H3WorkerJob): string { return typeof job.error === "string" ? job.error : job.error?.message ?? `H3 worker job ${job.status}.`; }
function requiredEnv(name: string): string { const value = process.env[name]?.trim() ?? ""; if (!value) throw new Error(`${name} is not configured.`); return value; }
function positiveNumber(value: string | undefined, fallback: number): number { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : fallback; }
function positiveInteger(value: string | undefined, fallback: number): number { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : fallback; }
function excludedCountries(): string[] { const configured = process.env.H3_VAST_EXCLUDED_COUNTRIES?.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean); return configured?.length ? configured : [...DEFAULT_EXCLUDED_H3_COUNTRIES]; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
