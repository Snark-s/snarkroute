import {
  DECISION_PROTOCOL,
  DecisionDispatcher,
  DecisionShadowBenchmark,
  InMemoryDecisionBenchmarkStore,
  ModelRegistry,
  RulesDecisionAdapter,
  aggregateDecisionBenchmarks,
  type DecisionExecutor,
  type DecisionAdapter,
  type DecisionRequest,
  type DecisionResponse,
  type ModelInfo
} from "@snarkroute/core";
import { JevDecisionAdapter, jevDecisionEngine } from "@snarkroute/jev";
import { NeedleDecisionAdapter, needleDecisionEngine } from "@snarkroute/needle";

export interface DecisionRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface DecisionEngineStatus {
  id: string;
  provider: string;
  operations: string[];
  declaredAvailability: ModelInfo["availability"];
  available: boolean;
  status: string;
}

export class ServerDecisionRuntime implements DecisionExecutor {
  readonly store = new InMemoryDecisionBenchmarkStore(2_000);
  readonly registry: ModelRegistry;
  readonly dispatcher: DecisionDispatcher;
  readonly executor: DecisionShadowBenchmark;
  readonly #adapters: DecisionAdapter[];
  readonly #needle: NeedleDecisionAdapter;

  constructor(options: DecisionRuntimeOptions = {}) {
    const env = options.env ?? process.env;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const jevEnabled = booleanEnv(env.JEV_ENABLED, false);
    const needleEnabled = booleanEnv(env.NEEDLE_ENABLED, false);
    const jevConfigured = jevEnabled && Boolean(env.JEV_API_KEY?.trim());
    const needleConfigured = needleEnabled && Boolean(env.NEEDLE_BASE_URL?.trim());

    const rules = new RulesDecisionAdapter({ id: "semantic-rules" });
    const jev = new JevDecisionAdapter({
      apiKey: jevConfigured ? env.JEV_API_KEY : undefined,
      endpoint: env.JEV_ENDPOINT,
      model: env.JEV_MODEL,
      fetch: fetchImpl
    });
    this.#needle = new NeedleDecisionAdapter({
      baseUrl: needleConfigured ? env.NEEDLE_BASE_URL : undefined,
      healthTimeoutMs: numberEnv(env.NEEDLE_HEALTH_TIMEOUT_MS, 2_000),
      fetch: fetchImpl
    });
    this.#adapters = [rules, jev, this.#needle];

    const engines = [
      rulesEngine(),
      jevDecisionEngine({ configured: jevConfigured, model: env.JEV_MODEL, priority: numberEnv(env.JEV_PRIORITY, 20) }),
      needleDecisionEngine({ configured: needleConfigured, weightsId: safeIdentifier(env.NEEDLE_WEIGHTS_ID), priority: numberEnv(env.NEEDLE_PRIORITY, 15) })
    ];
    this.registry = new ModelRegistry(engines);
    const defaultProduction = [
      "semantic-rules",
      ...(jevConfigured ? ["jev-main"] : []),
      ...(needleConfigured ? ["needle-local"] : [])
    ];
    this.dispatcher = new DecisionDispatcher(this.registry, this.#adapters, {
      fallback: {
        engineIds: listEnv(env.DECISION_PRODUCTION_BACKENDS, defaultProduction),
        maxAttempts: numberEnv(env.DECISION_MAX_ATTEMPTS, 3),
        timeoutMs: numberEnv(env.DECISION_TIMEOUT_MS, 30_000)
      }
    });
    this.executor = new DecisionShadowBenchmark(this.dispatcher, this.dispatcher, {
      enabled: booleanEnv(env.DECISION_SHADOW_ENABLED, false),
      backendIds: listEnv(env.DECISION_SHADOW_BACKENDS, []),
      sampleRate: decimalEnv(env.DECISION_SHADOW_SAMPLE_RATE, 0),
      timeoutMs: numberEnv(env.DECISION_SHADOW_TIMEOUT_MS, 10_000),
      store: this.store
    });
  }

  execute(request: DecisionRequest): Promise<DecisionResponse> {
    return this.executor.execute(request);
  }

  async statuses(): Promise<DecisionEngineStatus[]> {
    const adapters = new Map(this.#adapters.map((adapter) => [adapter.id, adapter]));
    return Promise.all(this.registry.listEngines().map(async (engine) => {
      const adapter = adapters.get(engine.adapterId ?? engine.providerId);
      const health = adapter?.health ? await adapter.health(engine).catch(() => false) : true;
      const available = typeof health === "boolean" ? health : health.available;
      return {
        id: engine.id,
        provider: engine.providerId,
        operations: engine.capabilities.filter((capability) => capability.startsWith("decision.")).map((capability) => capability.slice("decision.".length)),
        declaredAvailability: engine.availability,
        available: engine.availability !== "unavailable" && available,
        status: typeof health === "boolean" ? (health ? "available" : "unavailable") : health.status ?? (available ? "available" : "unavailable")
      };
    }));
  }

  benchmarkSnapshot() {
    const records = this.store.list();
    return { enabledRecords: records.length, pending: this.executor.pendingCount, aggregates: aggregateDecisionBenchmarks(records), records };
  }

  async close(): Promise<void> {
    await this.executor.close();
    await this.#needle.close();
  }
}

export function createDecisionRuntimeFromEnv(options: DecisionRuntimeOptions = {}): ServerDecisionRuntime {
  return new ServerDecisionRuntime(options);
}

function rulesEngine(): ModelInfo {
  return {
    id: "semantic-rules",
    providerId: "local",
    title: "Deterministic decision rules",
    kind: "decision",
    protocols: [DECISION_PROTOCOL],
    capabilities: ["decision.select_one", "decision.rank", "decision.classify", "decision.score"],
    availability: "available",
    priority: 0,
    adapterId: "semantic-rules"
  };
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function numberEnv(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function decimalEnv(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function listEnv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  return parsed.length ? [...new Set(parsed)] : fallback;
}

function safeIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && !/[\\/]/.test(normalized) ? normalized : undefined;
}
