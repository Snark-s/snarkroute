export type VastOffer = {
  id: number;
  dph_total: number;
  gpu_name: string;
  gpu_ram: number;
  cpu_ram: number;
  disk_space: number;
  cuda_max_good: number;
  reliability2?: number;
  reliability?: number;
  geolocation?: string;
  num_gpus: number;
  direct_port_count?: number;
  verification?: string;
  rentable?: boolean;
};

export type VastInstance = {
  id: number;
  actual_status?: string | null;
  status_msg?: string | null;
  public_ipaddr?: string | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  ports?: unknown;
  dph_total?: number;
  gpu_name?: string;
  gpu_ram?: number;
  cpu_ram?: number;
  geolocation?: string;
};

export const DEFAULT_EXCLUDED_H3_COUNTRIES = [
  "US", "GB", "KR",
  "AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"
] as const;

export class VastClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("VAST_API_KEY is required.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://console.vast.ai/api/v0").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async searchH3Offers(options: { limit?: number; allocatedStorageGb?: number } = {}): Promise<VastOffer[]> {
    const payload = await this.json("/bundles/", {
      method: "POST",
      body: JSON.stringify({
        verified: { eq: true },
        rentable: { eq: true },
        rented: { eq: false },
        num_gpus: { eq: 1 },
        gpu_ram: { gte: 49_152 },
        cpu_ram: { gte: 262_144 },
        disk_space: { gte: options.allocatedStorageGb ?? 300 },
        reliability2: { gte: 0.985 },
        cuda_max_good: { gte: 13 },
        direct_port_count: { gte: 2 },
        cpu_arch: { eq: "amd64" },
        allocated_storage: options.allocatedStorageGb ?? 300,
        order: [["dph_total", "asc"]],
        type: "ondemand",
        limit: options.limit ?? 50
      })
    });
    const offers = Array.isArray(payload.offers) ? payload.offers : [];
    return offers.filter(isVastOffer);
  }

  async createInstance(offerId: number, input: { templateHash: string; diskGb?: number; label: string; env?: Record<string, string>; onstart?: string }): Promise<{ instanceId: number; instanceApiKey?: string }> {
    assertId(offerId, "Vast offer id");
    const templateHash = input.templateHash.trim();
    if (!templateHash) throw new Error("H3 Vast template hash is required.");
    const payload = await this.json(`/asks/${offerId}/`, {
      method: "PUT",
      body: JSON.stringify({
        template_hash_id: templateHash,
        label: input.label,
        disk: input.diskGb ?? 300,
        target_state: "running",
        cancel_unavail: true,
        ...(input.env ? { env: input.env } : {}),
        ...(input.onstart ? { onstart: input.onstart } : {})
      })
    });
    const instanceId = numberField(payload.new_contract);
    if (!instanceId) throw new Error(stringField(payload.msg) ?? "Vast did not return the new instance id.");
    return { instanceId, ...(stringField(payload.instance_api_key) ? { instanceApiKey: stringField(payload.instance_api_key)! } : {}) };
  }

  async getInstance(instanceId: number): Promise<VastInstance | null> {
    assertId(instanceId, "Vast instance id");
    const response = await this.request(`/instances/${instanceId}`, { method: "GET" }, true);
    if (response.status === 404) return null;
    const payload = await parseJson(response);
    const value = record(payload.instances) ?? record(payload.instance);
    if (!value) throw new Error(stringField(payload.msg) ?? `Vast instance ${instanceId} response is malformed.`);
    return value as VastInstance;
  }

  async waitUntilRunning(instanceId: number, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<VastInstance> {
    const started = Date.now();
    while (Date.now() - started < (options.timeoutMs ?? 20 * 60_000)) {
      const instance = await this.getInstance(instanceId);
      if (!instance) throw new Error(`Vast instance ${instanceId} disappeared during startup.`);
      if (instance.actual_status === "running") return instance;
      if (["exited", "unknown", "offline"].includes(String(instance.actual_status))) throw new Error(`Vast instance ${instanceId} entered terminal startup state ${instance.actual_status}: ${instance.status_msg ?? "no status message"}`);
      await delay(options.pollMs ?? 10_000);
    }
    throw new Error(`Vast instance ${instanceId} did not become ready before the startup timeout.`);
  }

  async destroyAndConfirm(instanceId: number, options: { retries?: number; delayMs?: number } = {}): Promise<void> {
    assertId(instanceId, "Vast instance id");
    const response = await this.request(`/instances/${instanceId}`, { method: "DELETE" }, true);
    if (response.status !== 404) {
      const payload = await parseJson(response);
      if (!response.ok || payload.success !== true) throw new Error(stringField(payload.msg) ?? `Vast failed to destroy instance ${instanceId}.`);
    }
    const retries = options.retries ?? 6;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (options.delayMs ?? 2_500) await delay(options.delayMs ?? 2_500);
      if (!await this.getInstance(instanceId)) return;
    }
    throw new Error(`Vast destroy was not confirmed: instance ${instanceId} is still present.`);
  }

  private async json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.request(path, init);
    const payload = await parseJson(response);
    if (!response.ok || payload.success === false) throw new Error(stringField(payload.msg) ?? stringField(payload.error) ?? `Vast API request failed (${response.status}).`);
    return payload;
  }

  private async request(path: string, init: RequestInit, allow404 = false): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok && !(allow404 && response.status === 404)) {
      const payload = await parseJson(response);
      throw new Error(stringField(payload.msg) ?? stringField(payload.error) ?? `Vast API request failed (${response.status}).`);
    }
    return response;
  }
}

export function selectH3VastOffer(offers: VastOffer[], options: { maxHourlyUsd: number; excludedCountryCodes?: readonly string[] }): VastOffer | null {
  const maximum = options.maxHourlyUsd;
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error("The Vast hourly price ceiling must be positive.");
  const excluded = new Set((options.excludedCountryCodes ?? DEFAULT_EXCLUDED_H3_COUNTRIES).map((code) => code.toUpperCase()));
  return offers
    .filter((offer) => {
      const country = countryCode(offer.geolocation);
      return offer.num_gpus === 1
      && offer.gpu_ram >= 49_152
      && offer.cpu_ram >= 262_144
      && offer.disk_space >= 300
      && offer.cuda_max_good >= 13
      && (offer.direct_port_count ?? 0) >= 2
      && (offer.reliability2 ?? offer.reliability ?? 0) >= 0.985
      && offer.dph_total <= maximum
      && Boolean(country)
      && !excluded.has(country);
    })
    .sort((left, right) => left.dph_total - right.dph_total)[0] ?? null;
}

function countryCode(geolocation: string | undefined): string {
  const match = geolocation?.trim().toUpperCase().match(/(?:^|,|\s)([A-Z]{2})$/);
  return match?.[1] ?? "";
}

function isVastOffer(value: unknown): value is VastOffer {
  const offer = record(value);
  return Boolean(offer
    && numberField(offer.id)
    && typeof offer.gpu_name === "string"
    && Number.isFinite(offer.dph_total)
    && Number.isFinite(offer.gpu_ram)
    && Number.isFinite(offer.cpu_ram)
    && Number.isFinite(offer.disk_space)
    && Number.isFinite(offer.cuda_max_good)
    && Number.isFinite(offer.num_gpus));
}

function assertId(value: number, label: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`); }
function numberField(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function stringField(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
async function parseJson(response: Response): Promise<Record<string, unknown>> { try { return record(await response.json()) ?? {}; } catch { return {}; } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
