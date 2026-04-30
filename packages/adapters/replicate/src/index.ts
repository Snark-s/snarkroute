import type { NodeRunner } from "@snarkroute/executor";

const API_BASE = "https://api.replicate.com/v1";

export interface ReplicateClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RunPredictionOptions {
  pollingIntervalMs?: number;
  timeoutMs?: number;
}

export interface ReplicatePredictionResult {
  predictionId: string;
  model: string;
  input: object;
  output: unknown;
  logs?: string;
  error?: unknown;
  status: string;
  metrics?: Record<string, unknown>;
  webUrl?: string;
}

export function createReplicateClient(options: ReplicateClientOptions = {}) {
  const token = options.token ?? process.env.REPLICATE_API_TOKEN;
  const fetcher = options.fetchImpl ?? fetch;

  async function request(path: string, init: RequestInit = {}) {
    if (!token) throw new Error("REPLICATE_API_TOKEN is required for Replicate requests.");
    const response = await fetcher(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Replicate request failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  return {
    async getModelSchema(model: string) {
      const [owner, name] = parseModel(model);
      return request(`/models/${owner}/${name}`);
    },

    async createPrediction(model: string, input: object) {
      parseModel(model);
      return request("/predictions", {
        method: "POST",
        body: JSON.stringify({ model, input })
      });
    },

    async getPrediction(predictionId: string) {
      return request(`/predictions/${predictionId}`);
    },

    async runPrediction(model: string, input: object, runOptions: RunPredictionOptions = {}): Promise<ReplicatePredictionResult> {
      const pollingIntervalMs = runOptions.pollingIntervalMs ?? 1000;
      const timeoutMs = runOptions.timeoutMs ?? 120000;
      const started = Date.now();
      const created = await this.createPrediction(model, input);
      let prediction = created;

      while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`Replicate prediction timed out after ${timeoutMs}ms`);
        }
        await delay(pollingIntervalMs);
        prediction = await this.getPrediction(prediction.id);
      }

      return {
        predictionId: prediction.id,
        model,
        input,
        output: prediction.output,
        logs: prediction.logs,
        error: prediction.error,
        status: prediction.status,
        metrics: prediction.metrics,
        webUrl: prediction.urls?.web
      };
    }
  };
}

export function createReplicateNodeRunner(options: ReplicateClientOptions = {}): NodeRunner {
  const client = createReplicateClient(options);
  return async ({ params }) => {
    const model = String(params.model ?? "");
    if (!model) throw new Error("replicate.model requires params.model.");
    const input = asObject(params.input ?? {});
    const result = await client.runPrediction(model, input, {
      pollingIntervalMs: Number(params.pollingIntervalMs ?? 1000),
      timeoutMs: Number(params.timeoutMs ?? 120000)
    });
    if (result.status !== "succeeded") {
      throw new Error(`Replicate prediction ${result.status}: ${result.error ?? "unknown error"}`);
    }
    return {
      output: {
        predictionId: result.predictionId,
        output: result.output,
        status: result.status,
        metrics: result.metrics,
        webUrl: result.webUrl
      },
      logs: result.logs ? [result.logs] : [],
      metrics: result.metrics,
      provenance: { provider: "replicate", model }
    };
  };
}

function parseModel(model: string): [string, string] {
  const [owner, name] = model.split("/");
  if (!owner || !name) throw new Error(`Invalid Replicate model "${model}". Expected owner/name.`);
  return [owner, name];
}

function asObject(value: unknown): object {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  throw new Error("Replicate input must be an object.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
