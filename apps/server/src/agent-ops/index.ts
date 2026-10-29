import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { AgentRegistry, type AgentRecord } from "./agents";
import { CapabilityCatalog, type ToolGroup } from "./catalog";
import { defaultComputerModeState, effectiveComputerMode, runningOwnerApps, validateScheduleRule, type ComputerModeState, type ManualMode, type ModeLimits, type ScheduleRule } from "./computer-mode";
import { currentOpsContext, opsContext } from "./context";
import { ClaudeCodeExecutor, CodexExecutor, LocalRouteExecutor, type ExecutorAdapter, type LocalTextModel } from "./executors";
import { agentOpsDataDirectory, sharedQuotaLedgerReady } from "./ledger-instance";
import { LockManager } from "./locks";
import { defaultCpuCount, ResourceDispatcher, type Decision, type Lease, type ResourceRequest, type Telemetry } from "./resources";
import { AgentOpsStore } from "./store";
import { AgentTaskService } from "./tasks";
import type { AgentIdentity, ComputerMode } from "./types";

/**
 * Agent operations: capability catalog, executor routing, quota ledger,
 * resource dispatcher, computer modes and the durable delegation queue, wired
 * once per server process.
 */

export type AgentOps = Awaited<ReturnType<typeof createAgentOps>>;

type TextRunner = (model: LocalTextModel, prompt: string, signal: AbortSignal) => Promise<{ ok: boolean; text?: string; error?: string; usage?: Record<string, number> }>;
let textRunner: TextRunner | undefined;

/** The route executor lives in the Fastify app; the local executor reaches it through this hook. */
export function setAgentOpsTextRunner(runner: TextRunner): void { textRunner = runner; }

export async function createAgentOps(options: { directory?: string; apiUrl?: string; adapters?: ExecutorAdapter[]; tickMs?: number; telemetry?: () => Promise<Telemetry>; workspaceRoots?: string[] } = {}) {
  const directory = options.directory ?? agentOpsDataDirectory();
  const store = new AgentOpsStore(directory);
  const supervisor = await import("../services/local-runtime-supervisor");
  const registryModule = await import("../services/local-runtime-registry");

  let modeState: ComputerModeState = { ...defaultComputerModeState(), ...await store.readState<Partial<ComputerModeState>>("computer-mode", {}) };
  modeState.limits = { ...defaultComputerModeState().limits, ...modeState.limits };
  const saveMode = () => store.writeState("computer-mode", modeState);
  const mode = async () => effectiveComputerMode(modeState);

  const telemetry = options.telemetry ?? (async (): Promise<Telemetry> => {
    const gpu = await supervisor.readGpuTelemetry();
    const total = Math.round(totalmem() / 1024 ** 2), free = Math.round(freemem() / 1024 ** 2);
    return { ...(gpu ? { gpu } : {}), memory: { totalMiB: total, usedMiB: total - free, freeMiB: free }, cpuCount: defaultCpuCount(), capturedAt: new Date().toISOString() };
  });

  const inlineHolders = new Set<string>();
  let tasks: AgentTaskService | undefined;
  const dispatcher = new ResourceDispatcher({
    telemetry,
    mode,
    ownerApps: () => runningOwnerApps(modeState.ownerApps),
    runtimeAdmission: async (runtimeId, modelId) => (await supervisor.admissionForLocalRuntime(runtimeId, "workload", modelId)).decision,
    declaredVramMiB: runtimeId => registryModule.getRegisteredLocalRuntime(runtimeId)?.recommendedFreeVramMiB,
    stillActive: async lease => {
      if (lease.holder.startsWith("inline:")) {
        if (inlineHolders.has(lease.holder)) return true;
        // After a restart an inline lease is only kept while its runtime still reports work.
        const snapshot = supervisor.recentLocalRuntimeSnapshot(10_000) ?? await supervisor.readLocalRuntimeSnapshot().catch(() => undefined);
        return Boolean(snapshot?.runtimes.find(runtime => runtime.id === lease.runtimeId)?.busy);
      }
      if (lease.holder.startsWith("agent-lease:")) return false;
      const task = tasks?.get(lease.holder);
      return Boolean(task && (task.state === "running" || task.state === "unknown_outcome"));
    },
    persist: state => store.writeState("leases", state)
  });
  dispatcher.restore(await store.readState("leases", {}));

  const ledger = await sharedQuotaLedgerReady();
  const subscriptions = await Promise.all([import("../services/claude-subscription"), import("../services/chatgpt-subscription")]);
  ledger.registerExternalActivity("claude_code", () => subscriptions[0].claudeSubscription().activeTurns);
  ledger.registerExternalActivity("codex_cli", () => subscriptions[1].chatGptSubscription().activeTurns);

  const locks = new LockManager({ persist: state => store.writeState("locks", state) });
  locks.restore(await store.readState("locks", {}));

  const registry = new AgentRegistry(options.workspaceRoots ?? defaultWorkspaceRoots(directory), { secret: tokenSecret(directory), persist: records => store.writeState("agents", { records }) });
  registry.restore({ records: (await store.readState<{ records?: AgentRecord[] }>("agents", {})).records, policies: await store.readState("policies", {}) });

  const adapters = options.adapters ?? [
    new LocalRouteExecutor({ pickModel: pickLocalTextModel, runText: (model, prompt, signal) => textRunner ? textRunner(model, prompt, signal) : Promise.resolve({ ok: false, error: "Исполнитель маршрутов ещё не подключён." }) }),
    new CodexExecutor({ auth: force => subscriptions[1].chatGptSubscription().auth(force), model: () => process.env.AGENT_OPS_CODEX_MODEL?.trim() || undefined }),
    new ClaudeCodeExecutor({ auth: force => subscriptions[0].claudeSubscription().auth(force), model: () => process.env.AGENT_OPS_CLAUDE_MODEL?.trim() || "sonnet" })
  ];

  tasks = new AgentTaskService({ store, registry, ledger, locks, dispatcher, adapters, mode, apiUrl: options.apiUrl ?? "http://127.0.0.1:4317",
    worktreeRoot: join(directory, "worktrees"), tickMs: options.tickMs });
  await tasks.init();
  const taskService = tasks;

  // Measured peaks refine the next estimate; sampling runs only while something holds a lease.
  const sampler = setInterval(() => {
    if (!dispatcher.list().length) return;
    void telemetry().then(value => dispatcher.observe(value)).catch(() => undefined);
  }, 3000);
  sampler.unref?.();

  const catalog = new CapabilityCatalog({
    adapters,
    probes: () => taskService.probeSnapshot(),
    ledger,
    profiles: () => dispatcher.listProfiles(),
    models: loadModelGroups,
    runtimes: async () => {
      const snapshot = supervisor.recentLocalRuntimeSnapshot(15_000) ?? await supervisor.readLocalRuntimeSnapshot();
      return snapshot.runtimes.map(runtime => ({ ...runtime, recommendedFreeVramMiB: registryModule.getRegisteredLocalRuntime(runtime.id)?.recommendedFreeVramMiB }));
    },
    agents: loadAgentApps,
    toolGroups: defaultToolGroups()
  });

  /** A lease an agent holds for its own heavy work (a script, a render) outside the delegation queue. */
  async function acquireAgentLease(identity: AgentIdentity, request: Omit<ResourceRequest, "holder" | "agentId" | "origin">): Promise<Decision> {
    if (request.class === "heavy" && !identity.policy.canUseHeavyGpu) return { granted: false, waitFor: "resources", reason: "Политика агента не разрешает тяжёлую работу с GPU." };
    return dispatcher.acquire({ ...request, holder: `agent-lease:${identity.id}:${randomUUID().slice(0, 8)}`, agentId: identity.id, origin: identity.kind === "owner" ? "owner" : "agent", ttlMs: Math.min(request.ttlMs ?? 15 * 60_000, 2 * 60 * 60_000) });
  }

  function releaseAgentLease(identity: AgentIdentity, leaseId: string): boolean {
    const lease = dispatcher.get(leaseId);
    if (!lease) return false;
    if (lease.agentId !== identity.id && identity.kind !== "owner") throw new Error(`Резерв ${leaseId} принадлежит ${lease.agentId}.`);
    dispatcher.release(leaseId);
    taskService.kick();
    return true;
  }

  async function withRuntimeLease<T>(runtimeId: string, modelId: string | undefined, run: () => Promise<T>): Promise<T> {
    const context = currentOpsContext();
    if (context.heldRuntimes?.includes(runtimeId)) return run();
    const demand = registryModule.getRegisteredLocalRuntime(runtimeId)?.demand ?? "unknown";
    const holder = `inline:${randomUUID()}`;
    const decision = await dispatcher.acquire({ holder, agentId: context.agentId, origin: context.origin, purpose: `${runtimeId}${modelId ? ` · ${modelId}` : ""} (${context.agentId})`,
      class: demand === "none" || demand === "light" ? "light" : "heavy", runtimeId, modelId, ttlMs: 30 * 60_000 });
    if (!decision.granted) throw new ResourceLeaseDeniedError(decision.reason, decision.waitFor, runtimeId);
    inlineHolders.add(holder);
    const heartbeat = setInterval(() => dispatcher.heartbeat(decision.lease.id), 60_000);
    heartbeat.unref?.();
    try {
      return await opsContext.run({ ...context, heldRuntimes: [...(context.heldRuntimes ?? []), runtimeId] }, run);
    } finally {
      clearInterval(heartbeat);
      inlineHolders.delete(holder);
      dispatcher.release(decision.lease.id);
      taskService.kick();
    }
  }

  async function status() {
    const [effective, resources, ownerApps] = await Promise.all([mode(), telemetry().catch(() => undefined), runningOwnerApps(modeState.ownerApps)]);
    const all = taskService.list({ limit: 10_000 });
    const counts = all.reduce<Record<string, number>>((sum, task) => { sum[task.state] = (sum[task.state] ?? 0) + 1; return sum; }, {});
    return {
      mode: effective,
      schedule: modeState.schedule,
      manual: modeState.manual ?? null,
      limits: modeState.limits,
      ownerApps,
      resources: resources ?? null,
      leases: dispatcher.list(),
      locks: locks.list(),
      queue: { counts, active: all.filter(task => !["verified", "failed", "cancelled"].includes(task.state)).length },
      executors: adapters.map(adapter => ({ id: adapter.id, label: adapter.label, tier: adapter.profile.costTier, probe: taskService.probeSnapshot().get(adapter.id) ?? null,
        ledger: ledger.view(adapter.id), availability: ledger.availability(adapter.id, adapter.profile.costTier) })),
      ledgerLimits: ledger.limits
    };
  }

  async function setManualMode(identity: AgentIdentity, next: { mode: ComputerMode | null; until?: string | null }): Promise<void> {
    if (!identity.policy.canSetComputerMode) throw new Error("Режим компьютера переключает только владелец.");
    if (next.mode === null) modeState.manual = undefined;
    else {
      if (!["owner_busy", "background", "free"].includes(next.mode)) throw new Error("Неизвестный режим.");
      if (next.until && !Number.isFinite(Date.parse(next.until))) throw new Error("until должен быть датой ISO.");
      modeState.manual = { mode: next.mode, setAt: new Date().toISOString(), by: identity.id, until: next.until ?? null } satisfies ManualMode;
    }
    await saveMode();
    taskService.kick();
  }

  async function setSchedule(identity: AgentIdentity, rules: ScheduleRule[]): Promise<void> {
    if (!identity.policy.canSetComputerMode) throw new Error("Расписание задаёт только владелец.");
    if (!Array.isArray(rules) || rules.length > 50) throw new Error("Нужен список правил (не больше 50).");
    for (const rule of rules) { const problem = validateScheduleRule(rule); if (problem) throw new Error(`Правило ${rule.id ?? "?"}: ${problem}`); }
    modeState.schedule = rules.map(rule => ({ id: rule.id, days: [...new Set(rule.days)].sort(), from: rule.from, to: rule.to, mode: rule.mode, ...(rule.label ? { label: rule.label.slice(0, 80) } : {}) }));
    await saveMode();
    taskService.kick();
  }

  async function setLimits(identity: AgentIdentity, limits: Partial<Record<ComputerMode, Partial<ModeLimits>>>): Promise<void> {
    if (!identity.policy.canSetComputerMode) throw new Error("Пределы режимов задаёт только владелец.");
    for (const key of Object.keys(limits) as ComputerMode[]) {
      if (!(key in modeState.limits)) continue;
      modeState.limits[key] = { ...modeState.limits[key], ...sanitizeLimits(limits[key] ?? {}) };
    }
    await saveMode();
    taskService.kick();
  }

  function close(): void { clearInterval(sampler); taskService.close(); }

  return { store, registry, ledger, locks, dispatcher, tasks: taskService, catalog, adapters, mode, status, setManualMode, setSchedule, setLimits, acquireAgentLease, releaseAgentLease, withRuntimeLease, close,
    modeState: () => modeState };
}

export class ResourceLeaseDeniedError extends Error {
  readonly code = "RESOURCE_LEASE_DENIED";
  readonly retryable = true;
  readonly details: Record<string, unknown>;
  constructor(message: string, readonly waitFor: "window" | "resources", runtimeId: string) {
    super(message);
    this.name = "ResourceLeaseDeniedError";
    this.details = { origin: "snarkroute", runtime: runtimeId, waitFor };
  }
}

let instance: Promise<AgentOps> | undefined;

export function startAgentOps(options?: Parameters<typeof createAgentOps>[0]): Promise<AgentOps> {
  return instance ??= createAgentOps(options);
}

export function agentOpsInstance(): Promise<AgentOps> | undefined { return instance; }

/** For tests that build several servers in one process. */
export function resetAgentOpsInstance(): void {
  void instance?.then(ops => ops.close()).catch(() => undefined);
  instance = undefined;
}

/**
 * The standard local-runtime paths (FLUX.3, Qwen edit, local LLMs, H3, upscale)
 * call this around their GPU work. Without a running agent-ops layer (unit
 * tests) it falls back to the previous admission check.
 */
export async function withLocalRuntimeLease<T>(runtimeId: string, modelId: string | undefined, run: () => Promise<T>): Promise<T> {
  const ops = instance ? await instance.catch(() => undefined) : undefined;
  if (!ops) {
    const { assertLocalRuntimeAdmission } = await import("../services/local-runtime-supervisor");
    await assertLocalRuntimeAdmission(runtimeId, modelId);
    return run();
  }
  return ops.withRuntimeLease(runtimeId, modelId, run);
}

function sanitizeLimits(value: Partial<ModeLimits>): Partial<ModeLimits> {
  const out: Partial<ModeLimits> = {};
  if (typeof value.heavy === "boolean") out.heavy = value.heavy;
  for (const key of ["maxHeavy", "maxLight", "reserveVramMiB", "reserveRamMiB", "reserveCpuPercent"] as const) {
    const number = Number(value[key]);
    if (value[key] !== undefined && Number.isFinite(number) && number >= 0) out[key] = Math.round(key === "reserveCpuPercent" ? Math.min(95, number) : number);
  }
  return out;
}

function defaultWorkspaceRoots(directory: string): string[] {
  const configured = process.env.AGENT_OPS_WORKSPACE_ROOTS?.split(";").map(item => item.trim()).filter(Boolean);
  if (configured?.length) return configured;
  return [join(directory, "sandbox"), join(directory, "worktrees"), "Y:\\Процесс", "Y:\\Приложения"].filter(path => path.startsWith(directory) || existsSync(path));
}

function tokenSecret(directory: string): Buffer {
  const file = join(directory, "secret.key");
  try { return Buffer.from(readFileSync(file, "utf8").trim(), "base64"); }
  catch {
    const secret = randomBytes(32);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return secret;
  }
}

/** The existing semantic router picks the model; only a local tier result counts for the local executor. */
async function pickLocalTextModel(prompt: string): Promise<LocalTextModel | undefined> {
  const [{ loadLiveModelCatalogV1 }, { modelOptionsForNodeV1 }, { selectSemanticModelOptionV1 }, registry] = await Promise.all([
    import("../routes/models"), import("../services/model-catalog-v1"), import("../services/semantic-model-selection"), import("../services/local-runtime-registry")
  ]);
  const options = modelOptionsForNodeV1("ai.text", await loadLiveModelCatalogV1("ai.text"));
  const result = await selectSemanticModelOptionV1(options, { nodeType: "ai.text", prompt, routingPolicy: { allowPaid: false, subscriptionModels: "exclude", localModels: "allow" } });
  if (result.status !== "ok" || result.selectedProvider !== "local_openai" || !result.selectedProviderModelId) return undefined;
  const option = result.models.find(model => model.id === result.selectedModelId);
  const runtime = registry.listRegisteredLocalRuntimes().find(item => item.modelIds.includes(result.selectedProviderModelId!)) ;
  const contextTokens = Number((option?.metadata as Record<string, unknown> | undefined)?.contextLength ?? 8192);
  return { provider: "local_openai", providerModelId: result.selectedProviderModelId, displayName: option?.displayName ?? result.selectedProviderModelId,
    runtimeId: runtime?.id ?? "ollama", contextTokens: Number.isFinite(contextTokens) ? contextTokens : 8192 };
}

async function loadModelGroups() {
  const [{ loadLiveModelCatalogV1 }, exposure] = await Promise.all([import("../routes/models"), import("../services/model-exposure")]);
  const [catalog, policy] = await Promise.all([loadLiveModelCatalogV1(), exposure.readModelExposurePolicy()]);
  const entries = exposure.modelExposureEntries(catalog, policy).filter(entry => entry.exposed);
  return exposure.groupModelExposure(entries, policy).map(group => ({
    type: group.type, label: group.label,
    models: group.providers.flatMap(provider => provider.models.map(model => ({ id: model.id, provider: provider.provider, providerModelId: model.providerModelId, name: model.displayName, local: provider.local, available: model.available })))
  }));
}

async function loadAgentApps() {
  const apps = await import("../services/autonomous-apps");
  const describe: Record<string, { title: string; summary: string; invoke: string }> = {
    tove: { title: "Шорёк (Tove)", summary: "Проактивный агент: цели, намерения, действия. Своё приложение и UI.", invoke: "Мастерская → Агенты; вопросы владельцу только через Секретаря" },
    factory: { title: "Фабрика (Factory)", summary: "Производство цифровых товаров; новые дизайны сначала на одобрение через Секретаря.", invoke: "Мастерская → Агенты" },
    buzha: { title: "Бужа", summary: "Бюро разовых заказов: ручной учёт и чат через Model Gateway; automation=false.", invoke: "local_runtime_start buzha; заказы вводятся вручную" }
  };
  const autonomous = await Promise.all((["tove", "factory", "buzha"] as const).map(async id => {
    const status = await apps.readAutonomousAppStatus(id).catch(() => undefined);
    return { id, ...describe[id], running: status ? status.running : null, state: status?.state };
  }));
  return [
    ...autonomous,
    { id: "secretary", title: "Секретарь", summary: "Единственное окно вопросов к владельцу (Google-таблица).", running: null, invoke: "Вопрос владельцу — только через Секретаря" },
    { id: "jabberwock", title: "Jabberwock / PersonaCore", summary: "Продолжение задач с общей памятью; маршруты jabberwock_*.", running: null, invoke: "jabberwock_* или Мастерская → Агенты" }
  ];
}

function defaultToolGroups(): ToolGroup[] {
  return [
    { id: "agent_ops", title: "Делегирование и ресурсы", summary: "Каталог, поручения исполнителям, резервы GPU/RAM, режим компьютера.", cost: "none",
      tools: ["agent_whoami", "agent_capabilities", "agent_capability_detail", "agent_delegate_submit", "agent_delegate_status", "agent_delegate_result", "agent_delegate_cancel", "agent_delegate_list", "agent_resource_acquire", "agent_resource_release", "computer_mode_status"], available: async () => true },
    { id: "images", title: "Изображения (FLUX.3, Qwen edit)", summary: "Генерация и точная правка изображений локально через Model Gateway.", cost: "local", resources: "тяжёлая GPU-задача, резерв через диспетчер",
      tools: ["image_generate", "image_job", "image_cancel", "image_view"], available: async () => process.env.FLUX3_NATIVE_ENABLED === "1" || process.env.QWEN_EDIT_ENABLED === "1" ? true : null },
    { id: "local_runtime", title: "Локальные рантаймы", summary: "Статус GPU, admission, запуск и остановка локальных моделей.", cost: "local", tools: ["local_runtime_status", "local_runtime_admission", "local_runtime_start", "local_runtime_stop"], available: async () => true },
    { id: "after_effects", title: "After Effects", summary: "Управление открытым проектом AE через панель CEP.", cost: "none", tools: ["ae_list_sessions", "ae_get_project", "ae_run_arbitrary_jsx"],
      available: async () => { const { aeBridgeService } = await import("../ae-bridge/service"); return aeBridgeService.listSessions().length > 0; } },
    { id: "jabberwock", title: "Маршруты Jabberwock", summary: "Долгие маршруты с супервизором и общей памятью.", cost: "mixed", tools: ["jabberwock_create_route", "jabberwock_start_route", "jabberwock_get_route_state"], available: async () => null },
    { id: "cozyclay", title: "CozyClay", summary: "3D-превиз сцены и камеры в браузерной студии.", cost: "none", tools: ["cozyclay_status", "cozyclay_inspect", "cozyclay_capture"], available: async () => null },
    { id: "tech_radar", title: "Техрадар", summary: "Исследование публичных репозиториев без запуска чужого кода.", cost: "none", tools: ["tech_radar_research", "tech_radar_catalog"], available: async () => true },
    { id: "models", title: "Каталог моделей", summary: "Какие модели владелец открыл для других сетей.", cost: "none", tools: ["models_list"], available: async () => true }
  ];
}
