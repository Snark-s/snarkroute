import type { FastifyInstance, FastifyRequest } from "fastify";
import { appMode } from "../services/env";
import { isLoopbackAddress, isLoopbackHost } from "./after-effects";
import { loadLiveModelCatalogV1 } from "./models";

/** OpenAI-compatible, local-only tool-calling adapter for CozyClay.
 * Model IDs come only from the SnarkRoute ai.text catalog; inference goes
 * through the configured SnarkRoute OpenRouter route, never CozyClay credentials.
 * No background inference, fallback, or extra model call.
 */
const ROOT = "/cozyclay/v1";
const MODEL_PREFIX = "snarkroute/";
const UPSTREAM = "https://openrouter.ai/api/v1/chat/completions";
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_TOKENS = 4096;

export type GatewayModel = { id: string; providerModelId: string; name: string };
export type GatewayDeps = {
  models(): Promise<GatewayModel[]>;
  fetchImpl: typeof fetch;
  apiKey(): string | undefined;
};

function ownLoopback(request: FastifyRequest): boolean {
  if (appMode() !== "local" || !isLoopbackAddress(request.ip) || !isLoopbackHost(request.hostname)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch { return false; }
}

/** Only physically routable, currently available OpenRouter text models. */
export async function snarkRouteCozyModels(): Promise<GatewayModel[]> {
  const catalog = await loadLiveModelCatalogV1("ai.text");
  const models = new Map<string, GatewayModel>();
  for (const item of catalog) {
    if (item.provider !== "openrouter" || item.availability?.status !== "available"
        || item.availability?.configured === false || !item.providerModelId) continue;
    const modelId = item.providerModelId;
    if (modelId.length > 180 || !/^[a-zA-Z0-9_.:\-/]+$/.test(modelId)) continue;
    const id = MODEL_PREFIX + modelId;
    models.set(id, { id, providerModelId: modelId, name: item.displayName || modelId });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function registerCozyClayModelGateway(app: FastifyInstance, overrides: Partial<GatewayDeps> = {}): void {
  const deps: GatewayDeps = {
    models: overrides.models ?? snarkRouteCozyModels,
    fetchImpl: overrides.fetchImpl ?? fetch,
    apiKey: overrides.apiKey ?? (() => process.env.OPENROUTER_API_KEY?.trim())
  };
  app.get(ROOT + "/models", async (request, reply) => {
    if (!ownLoopback(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    try {
      if (!deps.apiKey()) return reply.code(503).send({ error: { message: "SnarkRoute OpenRouter provider is not configured." } });
      const models = await deps.models();
      reply.header("cache-control", "no-store");
      return { object: "list", data: models.map(model => ({
        id: model.id, object: "model", created: 0, owned_by: "snarkroute"
      })) };
    } catch {
      return reply.code(503).send({ error: { message: "SnarkRoute model catalog temporarily unavailable." } });
    }
  });

  app.post(ROOT + "/chat/completions", { bodyLimit: MAX_REQUEST_BYTES }, async (request, reply) => {
    if (!ownLoopback(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    const key = deps.apiKey();
    if (!key) return reply.code(503).send({ error: { message: "SnarkRoute OpenRouter provider is not configured." } });
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      return reply.code(400).send({ error: { message: "Expected OpenAI-compatible JSON body." } });
    }
    const body = request.body as Record<string, unknown>;
    const id = body.model;
    if (typeof id !== "string" || !id.startsWith(MODEL_PREFIX)) {
      return reply.code(400).send({ error: { message: "Choose a model from the SnarkRoute catalog." } });
    }
    const models = await deps.models().catch(() => []);
    const route = models.find(model => model.id === id);
    if (!route) return reply.code(404).send({ error: { message: "Requested SnarkRoute route is not available." } });
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 150) {
      return reply.code(400).send({ error: { message: "A bounded messages array is required." } });
    }
    // OpenRouter speaks OpenAI ChatCompletions with tool_call chunks and SSE.
    // Forward only OpenAI-compatible fields; never accept client URLs, provider,
    // credentials, routing policy, or unrestricted side-effect parameters.
    const fields = [
      "messages", "tools", "tool_choice", "parallel_tool_calls", "stream",
      "temperature", "top_p", "frequency_penalty", "presence_penalty",
      "stop", "response_format", "seed"
    ];
    const forwarding = Object.fromEntries(fields
      .filter(field => Object.prototype.hasOwnProperty.call(body, field))
      .map(field => [field, body[field]]));
    const requested = typeof body.max_tokens === "number" ? body.max_tokens
      : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : 2048;
    const upstreamBody = {
      ...forwarding,
      model: route.providerModelId,
      max_tokens: Math.max(1, Math.min(MAX_TOKENS, Math.trunc(requested)))
    };
    const stream = body.stream === true;
    // There is no automatic retry or paid fallback. A model call happens only
    // as the consequence of an explicit CozyClay turn.
    let response: Response;
    try {
      response = await deps.fetchImpl(UPSTREAM, {
        method: "POST", signal: AbortSignal.timeout(180_000),
        headers: {
          "authorization": "Bearer " + key,
          "content-type": "application/json",
          "HTTP-Referer": "http://127.0.0.1:4317",
          "X-Title": "SnarkRoute CozyClay Gateway"
        },
        body: JSON.stringify(upstreamBody)
      });
    } catch {
      return reply.code(502).send({ error: { message: "SnarkRoute provider request failed." } });
    }
    const contentType = response.headers.get("content-type") || (stream ? "text/event-stream" : "application/json");
    if (!response.ok) {
      // Return a bounded provider error, never expose a request's secrets.
      const detail = (await response.text().catch(() => "")).slice(0, 800);
      return reply.code(response.status >= 400 && response.status < 600 ? response.status : 502)
        .send({ error: { message: detail || "Provider rejected the request.", type: "upstream_error" } });
    }
    if (!stream) {
      try {
        const data = await response.json();
        return reply.header("content-type", "application/json").send(data);
      } catch {
        return reply.code(502).send({ error: { message: "Provider returned invalid JSON." } });
      }
    }
    if (!response.body) return reply.code(502).send({ error: { message: "Provider returned no SSE data." } });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive"
    });
    try {
      for await (const part of response.body) {
        if (reply.raw.destroyed) break;
        reply.raw.write(part);
      }
    } catch {
      // Never synthesize a tool-call completion after a partial stream.
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });
}
