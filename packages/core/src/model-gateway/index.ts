export type ModelCapability =
  | "text.generate"
  | "text.classify"
  | "text.edit"
  | "image.generate"
  | "image.upscale"
  | "image.analyze"
  | "video.generate"
  | "audio.transcribe"
  | "embedding.create"
  | (string & {});

export type ModelProviderId = string;

export interface ModelInfo {
  id: string;
  providerId: ModelProviderId;
  title: string;
  capabilities: ModelCapability[];
  inputTypes?: string[];
  outputTypes?: string[];
  contextWindow?: number;
  supportsStreaming?: boolean;
  supportsImages?: boolean;
  supportsVideo?: boolean;
  supportsJson?: boolean;
  defaultParameters?: Record<string, unknown>;
  pricingHint?: string;
  qualityHint?: "draft" | "balanced" | "best" | number | string;
  speedHint?: "fast" | "balanced" | "best" | number | string;
  metadata?: Record<string, unknown>;
}

export interface ProviderConnection {
  providerId: ModelProviderId;
  enabled: boolean;
  credentialRef?: string;
  secretRef?: string;
  baseUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelSelectionPreferences {
  speed?: "fast" | "balanced" | "best";
  cost?: "low" | "balanced" | "high";
  quality?: "draft" | "balanced" | "best";
}

export interface ModelInvokeRequest {
  capability: ModelCapability;
  modelRef?: string;
  providerId?: ModelProviderId;
  input: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  preferences?: ModelSelectionPreferences;
  metadata?: Record<string, unknown>;
}

export interface ModelInvokeResult {
  modelId: string;
  providerId: ModelProviderId;
  capability: ModelCapability;
  output: Record<string, unknown>;
  usage?: Record<string, unknown>;
  raw?: unknown;
  warnings?: string[];
}

export interface ProviderAdapter {
  id: ModelProviderId;
  title: string;
  capabilities: ModelCapability[];
  listModels?(connection?: ProviderConnection): Promise<ModelInfo[]>;
  invoke(request: ModelInvokeRequest & { model: ModelInfo }, connection?: ProviderConnection): Promise<ModelInvokeResult>;
}

export class ModelRegistry {
  readonly #models = new Map<string, ModelInfo>();

  constructor(models: ModelInfo[] = []) {
    for (const model of models) this.register(model);
  }

  register(model: ModelInfo): void {
    this.#models.set(model.id, { ...model, capabilities: [...model.capabilities] });
  }

  findByModelRef(modelRef: string): ModelInfo | undefined {
    const parsed = parseModelRef(modelRef);
    return parsed ? this.findByProviderModel(parsed.providerId, parsed.modelId) : this.#models.get(modelRef);
  }

  findByCapability(capability: ModelCapability, providerId?: ModelProviderId): ModelInfo[] {
    return this.listModels().filter((model) => model.capabilities.includes(capability) && (!providerId || model.providerId === providerId));
  }

  listModels(providerId?: ModelProviderId): ModelInfo[] {
    return [...this.#models.values()].filter((model) => !providerId || model.providerId === providerId);
  }

  private findByProviderModel(providerId: ModelProviderId, modelId: string): ModelInfo | undefined {
    return this.listModels(providerId).find((model) => model.id === modelId || providerModelRef(model) === `model://${providerId}/${modelId}`);
  }
}

export class GatewayModelResolver {
  constructor(private readonly registry: ModelRegistry, private readonly getConnection: (providerId: ModelProviderId) => ProviderConnection | undefined) {}

  resolve(request: ModelInvokeRequest): ModelInfo {
    if (request.modelRef) {
      const model = this.registry.findByModelRef(request.modelRef);
      if (!model) throw new Error(`Model Gateway could not resolve modelRef "${request.modelRef}".`);
      if (!model.capabilities.includes(request.capability)) throw new Error(`Model "${model.id}" does not support capability "${request.capability}".`);
      this.assertEnabled(model.providerId);
      return model;
    }

    const candidates = this.registry
      .findByCapability(request.capability, request.providerId)
      .filter((model) => this.getConnection(model.providerId)?.enabled);
    if (candidates.length === 0) throw new Error(`Model Gateway could not find an enabled model for capability "${request.capability}".`);
    return sortByPreferences(candidates, request.preferences)[0];
  }

  private assertEnabled(providerId: ModelProviderId): void {
    const connection = this.getConnection(providerId);
    if (!connection?.enabled) throw new Error(`Provider "${providerId}" is not enabled for Model Gateway.`);
  }
}

export class ModelGateway {
  readonly registry: ModelRegistry;
  readonly resolver: GatewayModelResolver;
  readonly #adapters = new Map<ModelProviderId, ProviderAdapter>();
  readonly #connections = new Map<ModelProviderId, ProviderConnection>();

  constructor(options: { models?: ModelInfo[]; adapters?: ProviderAdapter[]; connections?: ProviderConnection[] } = {}) {
    this.registry = new ModelRegistry(options.models);
    for (const adapter of options.adapters ?? []) this.registerAdapter(adapter);
    for (const connection of options.connections ?? []) this.registerConnection(connection);
    this.resolver = new GatewayModelResolver(this.registry, (providerId) => this.#connections.get(providerId));
  }

  registerModel(model: ModelInfo): void {
    this.registry.register(model);
  }

  registerAdapter(adapter: ProviderAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  registerConnection(connection: ProviderConnection): void {
    assertConnectionDoesNotCarrySecret(connection);
    this.#connections.set(connection.providerId, { ...connection });
  }

  async invoke(request: ModelInvokeRequest): Promise<ModelInvokeResult> {
    const model = this.resolver.resolve(request);
    const adapter = this.#adapters.get(model.providerId);
    if (!adapter) throw new Error(`Model Gateway has no adapter for provider "${model.providerId}".`);
    if (!adapter.capabilities.includes(request.capability)) throw new Error(`Provider adapter "${adapter.id}" does not support capability "${request.capability}".`);
    const connection = this.#connections.get(model.providerId);
    return adapter.invoke({ ...request, model }, connection);
  }
}

export function providerModelRef(model: ModelInfo): string {
  return `model://${model.providerId}/${model.id}`;
}

function parseModelRef(modelRef: string): { providerId: ModelProviderId; modelId: string } | null {
  const match = /^model:\/\/([^/]+)\/(.+)$/.exec(modelRef);
  return match ? { providerId: match[1], modelId: match[2] } : null;
}

function assertConnectionDoesNotCarrySecret(connection: ProviderConnection): void {
  const record = connection as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (/api[_-]?key|token|secret/i.test(key) && key !== "secretRef") {
      throw new Error(`ProviderConnection must use credentialRef/secretRef instead of carrying "${key}".`);
    }
  }
}

function sortByPreferences(models: ModelInfo[], preferences: ModelSelectionPreferences | undefined): ModelInfo[] {
  if (!preferences) return models;
  return [...models].sort((a, b) => preferenceScore(b, preferences) - preferenceScore(a, preferences));
}

function preferenceScore(model: ModelInfo, preferences: ModelSelectionPreferences): number {
  return scoreHint(model.speedHint, preferences.speed, { fast: 3, balanced: 2, best: 1 })
    + scoreHint(model.qualityHint, preferences.quality, { best: 3, balanced: 2, draft: 1 })
    + scoreCost(model.pricingHint, preferences.cost);
}

function scoreHint(value: ModelInfo["speedHint"] | ModelInfo["qualityHint"], preferred: string | undefined, weights: Record<string, number>): number {
  if (!preferred) return 0;
  if (typeof value === "number") return value;
  return value === preferred ? weights[preferred] ?? 1 : 0;
}

function scoreCost(pricingHint: string | undefined, preferred: ModelSelectionPreferences["cost"]): number {
  if (!preferred || !pricingHint) return 0;
  if (preferred === "low" && /low|cheap/i.test(pricingHint)) return 2;
  if (preferred === "high" && /premium|high/i.test(pricingHint)) return 2;
  if (preferred === "balanced" && /balanced|standard/i.test(pricingHint)) return 2;
  return 0;
}
