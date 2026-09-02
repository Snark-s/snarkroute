export type H3CapabilityStatus = {
  name: string;
  available: boolean;
  experimental?: boolean;
  reason?: string | null;
};

export type H3ConnectionStatus = {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  workerUrl: string;
  backend?: string;
  backendVersion?: string;
  reason?: string | null;
  activeJobs?: number;
  capabilities: H3CapabilityStatus[];
  error?: string;
};

type H3ConnectionOptions = {
  workerUrl?: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function inspectH3Connection(options: H3ConnectionOptions = {}): Promise<H3ConnectionStatus> {
  const rawWorkerUrl = options.workerUrl ?? process.env.H3_WORKER_URL ?? "";
  const serviceToken = (options.serviceToken ?? process.env.H3_WORKER_SERVICE_TOKEN ?? "").trim();
  let workerUrl = "";
  try {
    workerUrl = normalizeH3WorkerUrl(rawWorkerUrl);
  } catch (error) {
    return {
      configured: Boolean(rawWorkerUrl.trim() && serviceToken),
      connected: false,
      ready: false,
      workerUrl: "",
      capabilities: [],
      error: error instanceof Error ? error.message : "H3 worker URL is invalid."
    };
  }
  const base = { configured: Boolean(workerUrl && serviceToken), connected: false, ready: false, workerUrl, capabilities: [] };
  if (!base.configured) return base;

  const fetcher = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const headers = { Authorization: `Bearer ${serviceToken}` };
  try {
    const readyResponse = await fetcher(`${workerUrl}/ready`, { headers, signal: controller.signal });
    const readyPayload = await jsonObject(readyResponse);
    if (!readyResponse.ok) {
      return {
        ...base,
        connected: readyResponse.status !== 401 && readyResponse.status !== 403,
        reason: stringField(readyPayload.reason),
        error: readyResponse.status === 401 || readyResponse.status === 403 ? "H3 worker rejected the service token." : `H3 worker is not ready (${readyResponse.status}).`
      };
    }

    const capabilitiesResponse = await fetcher(`${workerUrl}/v1/capabilities`, { headers, signal: controller.signal });
    const capabilitiesPayload = await jsonObject(capabilitiesResponse);
    const capabilities = Array.isArray(capabilitiesPayload.capabilities)
      ? capabilitiesPayload.capabilities.filter(isCapabilityStatus)
      : [];

    return {
      ...base,
      connected: true,
      ready: readyPayload.ready === true,
      backend: stringField(readyPayload.backend) ?? stringField(capabilitiesPayload.backend),
      backendVersion: stringField(readyPayload.backendVersion) ?? stringField(capabilitiesPayload.backendVersion),
      reason: stringField(readyPayload.reason),
      activeJobs: numberField(readyPayload.activeJobs),
      capabilities,
      ...(capabilitiesResponse.ok ? {} : { error: `H3 capabilities request failed (${capabilitiesResponse.status}).` })
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error && error.name === "AbortError" ? "H3 worker connection timed out." : "H3 worker is unreachable."
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeH3WorkerUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("H3 worker URL must be a valid http:// or https:// address.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("H3 worker URL must be a plain http:// or https:// address without credentials, query, or fragment.");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !localHost) {
    throw new Error("A remote H3 worker must use HTTPS. Use an HTTPS endpoint or connect through a local SSH tunnel.");
  }
  return url.toString().replace(/\/$/, "");
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isCapabilityStatus(value: unknown): value is H3CapabilityStatus {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.name === "string" && typeof item.available === "boolean";
}
