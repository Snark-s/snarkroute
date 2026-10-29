import type { ExecutorAdapter, ExecutorProbe } from "./executors";
import type { QuotaLedger } from "./quota-ledger";
import type { ResourceProfile } from "./resources";
import type { AgentIdentity } from "./types";

/**
 * One catalog of what exists and what works right now. Every entry separates
 * four facts: registered (declared in SnarkRoute), discovered (found on this
 * computer), available (usable now) and verified (a recorded successful run),
 * each with its source and time. Short entries by default, details on request.
 */

export type CatalogKind = "executor" | "model_group" | "tool_group" | "service" | "agent";

export type CatalogStatus = {
  registered: boolean;
  discovered: boolean | null;
  available: boolean | null;
  verified: { at: string; how: string } | null;
  checkedAt?: string;
  source: string;
  detail?: string;
};

export type CatalogEntry = {
  id: string;
  kind: CatalogKind;
  title: string;
  summary: string;
  status: CatalogStatus;
  permitted: boolean;
  cost: "local" | "subscription" | "free" | "paid_or_unknown" | "mixed" | "none";
  resources?: string;
  invoke: string;
};

export type CatalogDetail = CatalogEntry & { details: Record<string, unknown> };

export type ModelGroupSource = () => Promise<Array<{ type: string; label: string; models: Array<{ id: string; provider: string; providerModelId: string; name: string; local: boolean; available: boolean }> }>>;
export type RuntimeSource = () => Promise<Array<{ id: string; label: string; online: boolean; discovered?: boolean; demand: string; state: string; detail?: string; recommendedFreeVramMiB?: number; endpoint?: string }>>;
export type AgentAppSource = () => Promise<Array<{ id: string; title: string; summary: string; running: boolean | null; state?: string; invoke: string }>>;
export type ToolGroup = { id: string; title: string; summary: string; tools: string[]; available: () => Promise<boolean | null>; cost: CatalogEntry["cost"]; resources?: string };

export type CatalogDeps = {
  adapters: ExecutorAdapter[];
  probes: () => Map<string, ExecutorProbe>;
  ledger: QuotaLedger;
  profiles: () => ResourceProfile[];
  models: ModelGroupSource;
  runtimes: RuntimeSource;
  agents: AgentAppSource;
  toolGroups: ToolGroup[];
};

export class CapabilityCatalog {
  private modelCache?: { at: number; value: Awaited<ReturnType<ModelGroupSource>> };

  constructor(private readonly deps: CatalogDeps) {}

  async list(identity: AgentIdentity, filter: { kind?: CatalogKind; query?: string; availableOnly?: boolean } = {}): Promise<CatalogEntry[]> {
    const entries = [
      ...this.executors(identity),
      ...await this.modelGroups(),
      ...await this.toolGroups(),
      ...await this.services(),
      ...await this.agentApps()
    ];
    const query = filter.query?.trim().toLowerCase();
    return entries.filter(entry => (!filter.kind || entry.kind === filter.kind)
      && (!filter.availableOnly || entry.status.available === true)
      && (!query || `${entry.id} ${entry.title} ${entry.summary}`.toLowerCase().includes(query)));
  }

  async detail(identity: AgentIdentity, id: string): Promise<CatalogDetail | undefined> {
    const entry = (await this.list(identity)).find(item => item.id === id);
    if (!entry) return undefined;
    const details: Record<string, unknown> = {};
    if (entry.kind === "executor") {
      const executorId = id.slice("executor:".length);
      const adapter = this.deps.adapters.find(item => item.id === executorId);
      details.profile = adapter?.profile;
      details.probe = this.deps.probes().get(executorId) ?? null;
      details.ledger = this.deps.ledger.view(executorId);
      details.limits = { concurrent: this.deps.ledger.limits.maxConcurrentPerExecutor[executorId] ?? 1, dailyRuns: this.deps.ledger.limits.dailyRunsPerExecutor[executorId] ?? null,
        sharedSubscriptionConcurrency: this.deps.ledger.limits.maxConcurrentSubscriptionRuns };
      details.how = "agent_delegate_submit {goal, acceptance, checks, workspace, executor?: '" + executorId + "', idempotencyKey}";
    } else if (entry.kind === "model_group") {
      const groups = await this.loadModels();
      details.models = groups.find(group => `models:${group.type}` === id)?.models.slice(0, 300) ?? [];
    } else if (entry.kind === "service") {
      details.measuredProfiles = this.deps.profiles().filter(profile => profile.key.startsWith(`${id.slice("service:".length)}|`));
    } else if (entry.kind === "tool_group") {
      details.tools = this.deps.toolGroups.find(group => `tools:${group.id}` === id)?.tools ?? [];
    }
    return { ...entry, details };
  }

  private executors(identity: AgentIdentity): CatalogEntry[] {
    const probes = this.deps.probes();
    return this.deps.adapters.map(adapter => {
      const probe = probes.get(adapter.id);
      const ledger = this.deps.ledger.view(adapter.id);
      const availability = this.deps.ledger.availability(adapter.id, adapter.profile.costTier);
      const available = probe ? Boolean(probe.installed && probe.authenticated !== false && availability.usable) : null;
      const quota = adapter.profile.costTier === "subscription"
        ? ` Квота: ${ledger.quota.state}${ledger.quota.usedPercent !== undefined ? ` (${ledger.quota.usedPercent}% окна, ${ledger.quota.source} ${ledger.quota.observedAt})` : ""}${ledger.nextAttemptAt ? `, следующая попытка ${ledger.nextAttemptAt}` : ""}.`
        : "";
      return {
        id: `executor:${adapter.id}`,
        kind: "executor" as const,
        title: adapter.label,
        summary: `${adapter.profile.kinds.join("/")}; ${adapter.profile.editsFiles ? "меняет файлы и запускает тесты" : "только текст"}; качество ${adapter.profile.quality}.${quota}`,
        status: {
          registered: true,
          discovered: probe ? probe.installed : null,
          available,
          verified: ledger.lastVerifiedAt ? { at: ledger.lastVerifiedAt, how: "поручение прошло проверки" } : null,
          checkedAt: probe?.checkedAt,
          source: probe?.source ?? "ещё не проверялся",
          detail: !availability.usable ? availability.reason : probe?.detail
        },
        permitted: identity.policy.allowedExecutors.includes(adapter.id),
        cost: adapter.profile.costTier,
        resources: adapter.profile.costTier === "local" ? "GPU/VRAM через диспетчер" : "1 поток CPU и диск локально; модель в облаке по подписке",
        invoke: `agent_delegate_submit (executor: ${adapter.id} или auto)`
      };
    });
  }

  private async loadModels() {
    if (this.modelCache && Date.now() - this.modelCache.at < 60_000) return this.modelCache.value;
    const value = await this.deps.models().catch(() => []);
    this.modelCache = { at: Date.now(), value };
    return value;
  }

  private async modelGroups(): Promise<CatalogEntry[]> {
    return (await this.loadModels()).map(group => {
      const available = group.models.filter(model => model.available);
      const local = available.filter(model => model.local).length;
      return {
        id: `models:${group.type}`,
        kind: "model_group" as const,
        title: `Модели: ${group.label}`,
        summary: `${available.length} доступно из ${group.models.length} (локальных ${local}). Подробности: agent_capability_detail.`,
        status: { registered: true, discovered: group.models.length > 0, available: available.length > 0, verified: null, checkedAt: new Date().toISOString(), source: "Model Catalog V1 + доступ для сетей" },
        permitted: true,
        cost: local === available.length && local > 0 ? "local" : "mixed",
        invoke: group.type === "image" ? "image_generate / Model Gateway" : "models_list, затем Model Gateway"
      };
    });
  }

  private async toolGroups(): Promise<CatalogEntry[]> {
    return Promise.all(this.deps.toolGroups.map(async group => {
      const available = await group.available().catch(() => null);
      return {
        id: `tools:${group.id}`, kind: "tool_group" as const, title: group.title, summary: group.summary,
        status: { registered: true, discovered: available === null ? null : true, available, verified: null, checkedAt: new Date().toISOString(),
          source: available === null ? "зарегистрирован; доступность проверяется при вызове" : "живая проверка" },
        permitted: true, cost: group.cost, resources: group.resources, invoke: group.tools.slice(0, 6).join(", ")
      };
    }));
  }

  private async services(): Promise<CatalogEntry[]> {
    const runtimes = await this.deps.runtimes().catch(() => []);
    const profiles = this.deps.profiles();
    return runtimes.map(runtime => {
      const measured = profiles.filter(profile => profile.key.startsWith(`${runtime.id}|`)).sort((a, b) => b.peakVramMiB - a.peakVramMiB)[0];
      return {
        id: `service:${runtime.id}`, kind: "service" as const, title: runtime.label,
        summary: `${runtime.state}${runtime.detail ? ` · ${runtime.detail.slice(0, 120)}` : ""}`,
        status: { registered: !runtime.discovered, discovered: runtime.discovered ? true : runtime.online, available: runtime.online, verified: null, checkedAt: new Date().toISOString(), source: "local runtime supervisor" },
        permitted: true, cost: "local" as const,
        resources: `нагрузка ${runtime.demand}${runtime.recommendedFreeVramMiB ? `, заявлено ${Math.round(runtime.recommendedFreeVramMiB / 1024)} ГБ VRAM` : ""}${measured ? `, измерено до ${(measured.peakVramMiB / 1024).toFixed(1)} ГБ (${measured.samples} замеров)` : ""}`,
        invoke: "local_runtime_status / local_runtime_admission; тяжёлую работу — через agent_resource_acquire"
      };
    });
  }

  private async agentApps(): Promise<CatalogEntry[]> {
    return (await this.deps.agents().catch(() => [])).map(app => ({
      id: `agent:${app.id}`, kind: "agent" as const, title: app.title, summary: app.summary,
      status: { registered: true, discovered: app.running === null ? null : true, available: app.running, verified: null, checkedAt: new Date().toISOString(), source: app.state ? `статус приложения: ${app.state}` : "реестр Мастерской" },
      permitted: true, cost: "none" as const, invoke: app.invoke
    }));
  }
}
