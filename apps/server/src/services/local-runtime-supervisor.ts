import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";
import { bonsaiRuntimeConfig, readBonsaiStatus, startBonsai, stopBonsai } from "./bonsai-local";
import { inspectH3Connection } from "./h3-connection";
import { h3LocalWslStatus, startH3LocalWsl, stopH3LocalWsl } from "./h3-local-wsl";
import { localUpscaleRuntimeConfig, readLocalUpscaleStatus, startLocalUpscale, stopLocalUpscale } from "./local-upscale-local";
import { readOllamaStatus, startOllama, stopOllama } from "./ollama-local";
import { readYue2Status, startYue2, stopYue2, yue2Config } from "./yue2-local";
import { writeEnvValue } from "./env";
import { localOpenAiConfigs } from "../providers/local-openai";
import {
  getRegisteredLocalRuntime,
  isRegisteredLocalRuntime,
  listRegisteredLocalRuntimes,
  localRuntimeController,
  registerLocalRuntimeController,
  registerLocalRuntimeEndpoint,
  type RegisteredLocalRuntime,
  type RegisteredRuntimeDemand
} from "./local-runtime-registry";

const execFileAsync = promisify(execFile);
const builtinRuntimeIds = new Set(["bonsai", "ollama", "h3", "yue2", "upscale"]);

export type LocalRuntimeId = string;
export type RuntimeDemand = RegisteredRuntimeDemand;
export type RuntimeClaim = "none" | "resident" | "active" | "unknown";
export type RuntimeState = "stopped" | "starting" | "loading" | "ready" | "busy" | "error";
export type AdmissionIntent = "workload" | "start";

export type LocalRuntimeStatus = {
  id: LocalRuntimeId;
  label: string;
  state: RuntimeState;
  online: boolean;
  busy: boolean;
  resourceClaim: RuntimeClaim;
  demand: RuntimeDemand;
  claimsOnStart: boolean;
  control: { canStart: boolean; canStop: boolean };
  activeJobs?: number;
  detail?: string;
  endpoint?: string;
  discovered?: boolean;
};

export type LocalRuntimeSnapshot = {
  capturedAt: string;
  gpu?: {
    name: string;
    totalMiB: number;
    usedMiB: number;
    freeMiB: number;
    utilizationPercent: number;
  };
  memory: { totalMiB: number; usedMiB: number; freeMiB: number };
  runtimes: LocalRuntimeStatus[];
  pressure: { level: "idle" | "busy" | "critical"; summary: string };
};

export type LocalRuntimeAdmission = {
  target: LocalRuntimeId;
  intent: AdmissionIntent;
  allowed: boolean;
  requiresConfirmation: boolean;
  blockers: string[];
  warnings: string[];
  conflictingRuntimeIds: LocalRuntimeId[];
  summary: string;
};

export class LocalRuntimeAdmissionError extends Error {
  constructor(readonly decision: LocalRuntimeAdmission) {
    super(decision.summary);
    this.name = "LocalRuntimeAdmissionError";
  }
}

export async function readLocalRuntimeSnapshot(): Promise<LocalRuntimeSnapshot> {
  ensureRuntimeRegistrations();
  const [bonsai, ollama, h3, yue2, upscale, gpu] = await Promise.all([
    readBonsaiStatus(),
    readOllamaStatus(),
    inspectH3Connection(),
    readYue2Status(),
    readLocalUpscaleStatus(),
    readGpuTelemetry()
  ]);
  const h3Local = h3LocalWslStatus(h3);
  const memory = memoryTelemetry();
  const builtins: LocalRuntimeStatus[] = [
    {
      ...runtimeBase("bonsai"),
      state: bonsai.status === "ready" ? "ready" : bonsai.status,
      online: bonsai.status !== "stopped" && bonsai.status !== "error",
      busy: false,
      resourceClaim: ["starting", "loading", "ready"].includes(bonsai.status) ? "resident" : "none",
      control: {
        canStart: bonsai.status === "stopped",
        canStop: ["starting", "loading", "ready"].includes(bonsai.status)
      },
      ...(bonsai.error ? { detail: bonsai.error } : {})
    },
    {
      ...runtimeBase("ollama"),
      state: ollama.status,
      online: ollama.online,
      busy: false,
      resourceClaim: ollama.residentModels.length ? "resident" : "none",
      control: {
        canStart: ollama.status === "stopped",
        canStop: ollama.online && (ollama.residentModels.length > 0 || ollama.status === "starting")
      },
      ...(ollama.residentModels.length ? { detail: `В памяти: ${ollama.residentModels.join(", ")}` } : ollama.error ? { detail: ollama.error } : {})
    },
    {
      ...runtimeBase("h3"),
      state: h3.ready ? (Number(h3.activeJobs ?? 0) > 0 ? "busy" : "ready") : "stopped",
      online: h3.ready,
      busy: Number(h3.activeJobs ?? 0) > 0,
      resourceClaim: Number(h3.activeJobs ?? 0) > 0 ? "active" : "none",
      activeJobs: Number(h3.activeJobs ?? 0),
      control: {
        canStart: !h3.ready && h3Local.supported,
        canStop: Boolean(h3Local.running)
      },
      ...(h3.ready ? { detail: h3.backend ? `${h3.backend}${h3.backendVersion ? ` · ${h3.backendVersion}` : ""}` : undefined } : h3.error ? { detail: h3.error } : {})
    },
    {
      ...runtimeBase("yue2"),
      state: yue2.status === "generating" ? "busy" : yue2.status === "error" ? "error" : yue2.status,
      online: yue2.status !== "stopped" && yue2.status !== "error",
      busy: yue2.generating,
      resourceClaim: yue2.generating ? "active" : yue2.model_loaded || yue2.status === "loading" ? "resident" : "none",
      control: {
        canStart: yue2.status === "stopped",
        canStop: yue2.status !== "stopped" && yue2.status !== "error"
      },
      ...(yue2.error ? { detail: yue2.error } : {})
    },
    {
      ...runtimeBase("upscale"),
      state: upscale.state,
      online: upscale.online,
      busy: upscale.activeJobs > 0,
      resourceClaim: upscale.activeJobs > 0 ? "active" : "none",
      activeJobs: upscale.activeJobs,
      control: {
        canStart: upscale.state === "stopped" && upscale.configured,
        canStop: upscale.online
      },
      ...(upscale.error ? { detail: upscale.error } : {})
    }
  ];

  const dynamicDefinitions = listRegisteredLocalRuntimes().filter(runtime => !builtinRuntimeIds.has(runtime.id));
  const dynamic = await Promise.all(dynamicDefinitions.map(readDiscoveredRuntimeStatus));
  const runtimes = [...builtins, ...dynamic];
  return {
    capturedAt: new Date().toISOString(),
    ...(gpu ? { gpu } : {}),
    memory,
    runtimes,
    pressure: pressure(runtimes, gpu, memory)
  };
}

export function planLocalRuntimeAdmission(
  target: LocalRuntimeId,
  snapshot: LocalRuntimeSnapshot,
  intent: AdmissionIntent = "workload"
): LocalRuntimeAdmission {
  const status = snapshot.runtimes.find(runtime => runtime.id === target);
  const registered = getRegisteredLocalRuntime(target);
  const profile = {
    label: status?.label ?? registered?.label ?? target,
    demand: status?.demand ?? registered?.demand ?? "unknown" as RuntimeDemand,
    claimsOnStart: status?.claimsOnStart ?? registered?.claimsOnStart ?? false,
    recommendedFreeVramMiB: registered?.recommendedFreeVramMiB
  };
  const effectiveDemand: RuntimeDemand = intent === "start" && !profile.claimsOnStart ? "none" : profile.demand;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const conflicts = new Set<LocalRuntimeId>();

  if (effectiveDemand !== "none" && effectiveDemand !== "light") {
    if (effectiveDemand === "unknown") {
      warnings.push(`${profile.label}: требования к GPU/VRAM не описаны. SnarkRoute будет ориентироваться только на текущую загрузку и известные конфликты.`);
    }

    for (const runtime of snapshot.runtimes) {
      if (runtime.id === target || runtime.resourceClaim === "none") continue;
      if (effectiveDemand === "exclusive") {
        conflicts.add(runtime.id);
        blockers.push(`${runtime.label} уже держит GPU-ресурсы (${claimLabel(runtime.resourceClaim)}). Перед локальной задачей ${profile.label} его лучше остановить.`);
        continue;
      }
      if (runtime.demand === "exclusive" && runtime.resourceClaim === "active") {
        conflicts.add(runtime.id);
        blockers.push(`${runtime.label} сейчас активно использует GPU. ${profile.label} нельзя безопасно запускать параллельно.`);
        continue;
      }
      if (runtime.resourceClaim === "unknown") {
        conflicts.add(runtime.id);
        warnings.push(`${runtime.label} запущен, но SnarkRoute пока не знает его реальную GPU-нагрузку. Параллельный запуск ${profile.label} требует осторожности.`);
        continue;
      }
      if (runtime.demand === "heavy" || runtime.resourceClaim === "resident" || runtime.resourceClaim === "active") {
        conflicts.add(runtime.id);
        warnings.push(`${runtime.label} уже держит большую модель или выполняет GPU-задачу. Параллельный запуск ${profile.label} может вызвать OOM или сильные подвисания.`);
      }
    }

    if (snapshot.gpu) {
      const usedRatio = snapshot.gpu.totalMiB > 0 ? snapshot.gpu.usedMiB / snapshot.gpu.totalMiB : 0;
      if (!blockers.length && usedRatio >= 0.7) {
        warnings.push(`GPU уже занят на ${Math.round(usedRatio * 100)}%: свободно ${formatGiB(snapshot.gpu.freeMiB)} из ${formatGiB(snapshot.gpu.totalMiB)}.`);
      }
      const recommended = profile.recommendedFreeVramMiB;
      if (recommended && snapshot.gpu.freeMiB < recommended) {
        warnings.push(`Для ${profile.label} желательно хотя бы ${formatGiB(recommended)} свободной VRAM; сейчас ${formatGiB(snapshot.gpu.freeMiB)}.`);
      }
    }

    if (snapshot.memory.totalMiB > 0 && snapshot.memory.freeMiB / snapshot.memory.totalMiB < 0.12) {
      warnings.push(`Оперативная память почти заполнена: свободно ${formatGiB(snapshot.memory.freeMiB)} из ${formatGiB(snapshot.memory.totalMiB)}. Система может начать активно свопить.`);
    }
  }

  const allowed = blockers.length === 0;
  const requiresConfirmation = allowed && warnings.length > 0;
  const summary = blockers[0]
    ?? warnings[0]
    ?? (effectiveDemand === "none"
      ? `${profile.label}: фоновый процесс можно запустить; тяжелые ресурсы он захватит только при работе.`
      : `${profile.label}: конфликтов с известными локальными runtime нет.`);

  return {
    target,
    intent,
    allowed,
    requiresConfirmation,
    blockers,
    warnings,
    conflictingRuntimeIds: [...conflicts],
    summary
  };
}

export async function admissionForLocalRuntime(target: LocalRuntimeId, intent: AdmissionIntent = "workload") {
  const snapshot = await readLocalRuntimeSnapshot();
  if (!snapshot.runtimes.some(runtime => runtime.id === target)) throw new Error(`Unknown local runtime: ${target}`);
  return { snapshot, decision: planLocalRuntimeAdmission(target, snapshot, intent) };
}

export async function assertLocalRuntimeAdmission(target: LocalRuntimeId): Promise<void> {
  const { decision } = await admissionForLocalRuntime(target, "workload");
  if (!decision.allowed) throw new LocalRuntimeAdmissionError(decision);
}

export async function startLocalRuntime(target: LocalRuntimeId, options: { force?: boolean } = {}) {
  ensureRuntimeRegistrations();
  const before = await readLocalRuntimeSnapshot();
  const decision = planLocalRuntimeAdmission(target, before, "start");
  if (!decision.allowed || decision.requiresConfirmation && !options.force) throw new LocalRuntimeAdmissionError(decision);
  const controller = localRuntimeController(target);
  if (!controller?.start) throw new Error(`${runtimeLabel(target)} обнаружен автоматически, но его адаптер не объявил безопасный способ запуска.`);
  await controller.start();
  return { decision, snapshot: await readLocalRuntimeSnapshot() };
}

export async function stopLocalRuntime(target: LocalRuntimeId) {
  ensureRuntimeRegistrations();
  const controller = localRuntimeController(target);
  if (!controller?.stop) throw new Error(`${runtimeLabel(target)} обнаружен автоматически, но его адаптер не объявил безопасный способ остановки.`);
  await controller.stop();
  return { snapshot: await readLocalRuntimeSnapshot() };
}

export function isLocalRuntimeId(value: string): value is LocalRuntimeId {
  return builtinRuntimeIds.has(value) || isRegisteredLocalRuntime(value);
}

function ensureRuntimeRegistrations(): void {
  let bonsaiEndpoint = "http://127.0.0.1:8080";
  try { bonsaiEndpoint = bonsaiRuntimeConfig().baseUrl; } catch {}
  registerLocalRuntimeEndpoint({ id: "bonsai", label: "Bonsai", endpoint: bonsaiEndpoint, demand: "heavy", claimsOnStart: true, source: "builtin" });
  registerLocalRuntimeController("bonsai", { start: startBonsai, stop: stopBonsai });

  registerLocalRuntimeEndpoint({ id: "ollama", label: "Ollama", endpoint: "http://127.0.0.1:11434", demand: "heavy", claimsOnStart: false, source: "builtin" });
  registerLocalRuntimeController("ollama", { start: startOllama, stop: stopOllama });

  const h3Endpoint = process.env.H3_WORKER_URL?.trim() || "http://127.0.0.1:18080";
  registerLocalRuntimeEndpoint({ id: "h3", label: "H3", endpoint: h3Endpoint, demand: "exclusive", claimsOnStart: false, source: "builtin" });
  registerLocalRuntimeController("h3", {
    start: async () => {
      const started = await startH3LocalWsl();
      await writeEnvValue("H3_WORKER_URL", started.status.workerUrl);
      await writeEnvValue("H3_WORKER_SERVICE_TOKEN", started.serviceToken);
      process.env.H3_WORKER_URL = started.status.workerUrl;
      process.env.H3_WORKER_SERVICE_TOKEN = started.serviceToken;
    },
    stop: stopH3LocalWsl
  });

  registerLocalRuntimeEndpoint({ id: "yue2", label: "YuE2", endpoint: yue2Config.url, demand: "heavy", claimsOnStart: true, source: "builtin" });
  registerLocalRuntimeController("yue2", { start: startYue2, stop: stopYue2 });

  try {
    const upscale = localUpscaleRuntimeConfig();
    registerLocalRuntimeEndpoint({ id: "upscale", label: "Upscale", endpoint: upscale.baseUrl, demand: "heavy", claimsOnStart: false, recommendedFreeVramMiB: 8192, source: "builtin" });
    registerLocalRuntimeController("upscale", { start: startLocalUpscale, stop: stopLocalUpscale });
  } catch {}

  for (const config of safeLocalOpenAiConfigs()) {
    registerLocalRuntimeEndpoint({
      endpoint: config.baseUrl,
      provider: "local_openai",
      demand: "unknown",
      claimsOnStart: false,
      source: "provider-metadata",
      modelIds: config.modelIds ?? [config.fallbackModelId]
    });
  }
}

function safeLocalOpenAiConfigs() {
  try { return localOpenAiConfigs(); }
  catch { return []; }
}

function runtimeBase(id: string) {
  const runtime = getRegisteredLocalRuntime(id);
  return {
    id,
    label: runtime?.label ?? id,
    demand: runtime?.demand ?? "unknown" as RuntimeDemand,
    claimsOnStart: runtime?.claimsOnStart ?? false,
    ...(runtime?.endpoint ? { endpoint: runtime.endpoint } : {})
  };
}

async function readDiscoveredRuntimeStatus(runtime: RegisteredLocalRuntime): Promise<LocalRuntimeStatus> {
  const online = await endpointReachable(runtime.endpoint);
  const controller = localRuntimeController(runtime.id);
  const resourceClaim: RuntimeClaim = !online
    ? "none"
    : runtime.claimsOnStart
      ? "resident"
      : runtime.demand === "none" || runtime.demand === "light"
        ? "none"
        : "unknown";
  const models = runtime.modelIds.length ? ` · модели: ${runtime.modelIds.join(", ")}` : "";
  return {
    id: runtime.id,
    label: runtime.label,
    state: online ? "ready" : "stopped",
    online,
    busy: false,
    resourceClaim,
    demand: runtime.demand,
    claimsOnStart: runtime.claimsOnStart,
    control: { canStart: !online && Boolean(controller?.start), canStop: online && Boolean(controller?.stop) },
    endpoint: runtime.endpoint,
    discovered: true,
    detail: `${runtime.provider ?? "local"} · ${runtime.endpoint}${models} · нагрузка ${runtime.demand === "unknown" ? "неизвестна" : runtime.demand}`
  };
}

function endpointReachable(endpoint: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let url: URL;
    try { url = new URL(endpoint); }
    catch { resolve(false); return; }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function readGpuTelemetry(): Promise<LocalRuntimeSnapshot["gpu"] | undefined> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu",
      "--format=csv,noheader,nounits"
    ], { timeout: 1500, windowsHide: true, maxBuffer: 16_384 });
    const first = stdout.trim().split(/\r?\n/)[0];
    if (!first) return undefined;
    const parts = first.split(",").map(value => value.trim());
    const [name, total, used, free, utilization] = parts;
    const values = [total, used, free, utilization].map(Number);
    if (!name || values.some(value => !Number.isFinite(value))) return undefined;
    return {
      name,
      totalMiB: Math.round(values[0]),
      usedMiB: Math.round(values[1]),
      freeMiB: Math.round(values[2]),
      utilizationPercent: Math.round(values[3])
    };
  } catch {
    return undefined;
  }
}

function memoryTelemetry(): LocalRuntimeSnapshot["memory"] {
  const total = Math.round(totalmem() / 1024 ** 2);
  const free = Math.round(freemem() / 1024 ** 2);
  return { totalMiB: total, usedMiB: Math.max(0, total - free), freeMiB: free };
}

function pressure(
  runtimes: LocalRuntimeStatus[],
  gpu: LocalRuntimeSnapshot["gpu"] | undefined,
  memory: LocalRuntimeSnapshot["memory"]
): LocalRuntimeSnapshot["pressure"] {
  const activeExclusive = runtimes.some(runtime => runtime.demand === "exclusive" && runtime.resourceClaim === "active");
  const claims = runtimes.filter(runtime => runtime.resourceClaim !== "none");
  const lowGpu = Boolean(gpu && gpu.freeMiB < 2048);
  const lowRam = memory.freeMiB < 2048;
  const level = activeExclusive || lowGpu || lowRam ? "critical" : claims.length || Boolean(gpu && gpu.usedMiB / Math.max(1, gpu.totalMiB) > 0.5) ? "busy" : "idle";
  const named = claims.map(runtime => runtime.label).join(", ");
  const gpuText = gpu ? `GPU ${formatGiB(gpu.usedMiB)} / ${formatGiB(gpu.totalMiB)}` : "GPU telemetry unavailable";
  return {
    level,
    summary: named ? `${gpuText}. Ресурсы держат или могут держать: ${named}.` : `${gpuText}. Известных тяжелых runtime сейчас нет.`
  };
}

function claimLabel(claim: RuntimeClaim): string {
  if (claim === "active") return "активная задача";
  if (claim === "resident") return "модель в памяти";
  if (claim === "unknown") return "нагрузка неизвестна";
  return "нет";
}

function runtimeLabel(id: string): string {
  return getRegisteredLocalRuntime(id)?.label ?? id;
}

function formatGiB(mib: number): string {
  return `${(mib / 1024).toFixed(mib >= 10 * 1024 ? 1 : 2)} ГБ`;
}
