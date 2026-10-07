export type RegisteredRuntimeDemand = "none" | "light" | "heavy" | "exclusive" | "unknown";

export type RegisteredLocalRuntime = {
  id: string;
  label: string;
  endpoint: string;
  origin: string;
  provider?: string;
  demand: RegisteredRuntimeDemand;
  claimsOnStart: boolean;
  recommendedFreeVramMiB?: number;
  source: "builtin" | "provider-metadata";
  modelIds: string[];
};

export type LocalRuntimeController = {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
};

type RuntimeModelLike = {
  provider?: unknown;
  providerModelId?: unknown;
  displayName?: unknown;
  metadata?: unknown;
};

const runtimes = new Map<string, RegisteredLocalRuntime>();
const runtimeIdByOrigin = new Map<string, string>();
const controllers = new Map<string, LocalRuntimeController>();

export function registerLocalRuntimeEndpoint(input: {
  id?: string;
  label?: string;
  endpoint: string;
  provider?: string;
  demand?: RegisteredRuntimeDemand;
  claimsOnStart?: boolean;
  recommendedFreeVramMiB?: number;
  source?: RegisteredLocalRuntime["source"];
  modelIds?: string[];
}): RegisteredLocalRuntime | null {
  const normalized = normalizeLoopbackEndpoint(input.endpoint);
  if (!normalized) return null;

  const source = input.source ?? "provider-metadata";
  const requestedId = sanitizeId(input.id) || runtimeIdFrom(input.provider, normalized.origin);
  const existingId = runtimeIdByOrigin.get(normalized.origin);
  const existing = existingId ? runtimes.get(existingId) : undefined;

  if (existing) {
    const incomingWinsIdentity = source === "builtin" && existing.source !== "builtin";
    const id = incomingWinsIdentity ? requestedId : existing.id;
    const merged: RegisteredLocalRuntime = {
      ...existing,
      id,
      label: incomingWinsIdentity ? cleanLabel(input.label) ?? existing.label : existing.label,
      endpoint: incomingWinsIdentity ? normalized.endpoint : existing.endpoint,
      origin: normalized.origin,
      provider: input.provider ?? existing.provider,
      demand: incomingWinsIdentity || existing.demand === "unknown" ? input.demand ?? existing.demand : existing.demand,
      claimsOnStart: incomingWinsIdentity ? input.claimsOnStart ?? existing.claimsOnStart : existing.claimsOnStart,
      recommendedFreeVramMiB: input.recommendedFreeVramMiB ?? existing.recommendedFreeVramMiB,
      source: incomingWinsIdentity ? source : existing.source,
      modelIds: unique([...(existing.modelIds ?? []), ...(input.modelIds ?? [])])
    };
    if (incomingWinsIdentity && existing.id !== id) {
      runtimes.delete(existing.id);
      const controller = controllers.get(existing.id);
      if (controller) {
        controllers.delete(existing.id);
        controllers.set(id, controller);
      }
    }
    runtimes.set(id, merged);
    runtimeIdByOrigin.set(normalized.origin, id);
    return merged;
  }

  const runtime: RegisteredLocalRuntime = {
    id: requestedId,
    label: cleanLabel(input.label) ?? (input.provider ? `${humanizeProvider(input.provider)} · ${normalized.hostPort}` : `Local ${normalized.hostPort}`),
    endpoint: normalized.endpoint,
    origin: normalized.origin,
    ...(input.provider ? { provider: input.provider } : {}),
    demand: input.demand ?? "unknown",
    claimsOnStart: input.claimsOnStart ?? false,
    ...(validPositiveNumber(input.recommendedFreeVramMiB) ? { recommendedFreeVramMiB: input.recommendedFreeVramMiB } : {}),
    source,
    modelIds: unique(input.modelIds ?? [])
  };
  runtimes.set(runtime.id, runtime);
  runtimeIdByOrigin.set(runtime.origin, runtime.id);
  return runtime;
}

export function registerLocalRuntimeController(id: string, controller: LocalRuntimeController): void {
  const normalizedId = sanitizeId(id);
  if (!normalizedId) throw new Error("Local runtime controller id is invalid.");
  controllers.set(normalizedId, controller);
}

export function localRuntimeController(id: string): LocalRuntimeController | undefined {
  return controllers.get(id);
}

export function registerLocalRuntimesFromModels(models: RuntimeModelLike[]): RegisteredLocalRuntime[] {
  const touched = new Map<string, RegisteredLocalRuntime>();
  for (const model of models) {
    const metadata = record(model.metadata);
    const providerMetadata = record(metadata.provider);
    const explicit = record(metadata.localRuntime);
    const providerExplicit = record(providerMetadata.localRuntime);
    const runtimeMetadata = Object.keys(explicit).length ? explicit : providerExplicit;
    const explicitEndpoint = string(runtimeMetadata.endpoint) ?? string(runtimeMetadata.baseUrl);
    const implicitEndpoint = metadata.local === true
      ? string(metadata.baseUrl) ?? string(metadata.endpoint)
      : providerMetadata.local === true
        ? string(providerMetadata.baseUrl) ?? string(providerMetadata.endpoint)
        : undefined;
    const endpoint = explicitEndpoint ?? implicitEndpoint;
    if (!endpoint) continue;

    const provider = string(model.provider);
    const providerModelId = string(model.providerModelId);
    const runtime = registerLocalRuntimeEndpoint({
      id: string(runtimeMetadata.id) ?? string(metadata.runtimeId) ?? string(providerMetadata.runtimeId),
      label: string(runtimeMetadata.label) ?? string(metadata.runtimeLabel) ?? string(providerMetadata.runtimeLabel),
      endpoint,
      provider,
      demand: runtimeDemand(runtimeMetadata.demand ?? metadata.resourceDemand ?? providerMetadata.resourceDemand),
      claimsOnStart: boolean(runtimeMetadata.claimsOnStart ?? metadata.claimsOnStart ?? providerMetadata.claimsOnStart),
      recommendedFreeVramMiB: number(runtimeMetadata.recommendedFreeVramMiB ?? metadata.recommendedFreeVramMiB ?? providerMetadata.recommendedFreeVramMiB),
      source: "provider-metadata",
      modelIds: providerModelId ? [providerModelId] : []
    });
    if (runtime) touched.set(runtime.id, runtime);
  }
  return [...touched.values()];
}

export function listRegisteredLocalRuntimes(): RegisteredLocalRuntime[] {
  return [...runtimes.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getRegisteredLocalRuntime(id: string): RegisteredLocalRuntime | undefined {
  return runtimes.get(id);
}

export function isRegisteredLocalRuntime(id: string): boolean {
  return runtimes.has(id);
}

export function clearRegisteredLocalRuntimesForTests(): void {
  runtimes.clear();
  runtimeIdByOrigin.clear();
  controllers.clear();
}

function normalizeLoopbackEndpoint(value: string): { endpoint: string; origin: string; hostPort: string } | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHostname(hostname) || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    const endpoint = url.toString().replace(/\/$/, "");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const origin = `${url.protocol}//127.0.0.1:${port}`;
    return { endpoint, origin, hostPort: `127.0.0.1:${port}` };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]"
    || hostname.endsWith(".localhost");
}

function runtimeIdFrom(provider: string | undefined, origin: string): string {
  const url = new URL(origin);
  const prefix = sanitizeId(provider) || "local";
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${prefix}-${host}-${port}`;
}

function runtimeDemand(value: unknown): RegisteredRuntimeDemand | undefined {
  return value === "none" || value === "light" || value === "heavy" || value === "exclusive" || value === "unknown"
    ? value
    : undefined;
}

function humanizeProvider(provider: string): string {
  return provider.split(/[_-]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function sanitizeId(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || undefined;
}

function cleanLabel(value: unknown): string | undefined {
  const text = string(value);
  return text?.slice(0, 80);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return validPositiveNumber(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function validPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
