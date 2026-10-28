import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCozyClayModelGateway } from "./cozyclay-model-gateway";

const servers: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
});

function gateway(fetchImpl?: typeof fetch) {
  const app = Fastify();
  servers.push(app);
  const fetchSpy = vi.fn(fetchImpl ?? (async () => new Response(JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "arrange_objects", arguments: "{}" } }] },
      finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch);
  registerCozyClayModelGateway(app, {
    apiKey: () => "injected-test-token",
    models: async () => [{ id: "snarkroute/openai/gpt-4o-mini", providerModelId: "openai/gpt-4o-mini", name: "test" }],
    fetchImpl: fetchSpy
  });
  return { app, fetchSpy };
}

describe("CozyClay SnarkRoute OpenAI-compatible gateway", () => {
  it("lists only SnarkRoute-backed models without exposing provider secrets", async () => {
    const { app } = gateway();
    const response = await app.inject({ method: "GET", url: "/cozyclay/v1/models" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].id).toBe("snarkroute/openai/gpt-4o-mini");
    expect(response.body).not.toContain("injected-test-token");
  });

  it("proxies ChatCompletions tool calls using only SnarkRoute provider credentials", async () => {
    const { app, fetchSpy } = gateway();
    const response = await app.inject({ method: "POST", url: "/cozyclay/v1/chat/completions",
      payload: { model: "snarkroute/openai/gpt-4o-mini", messages: [{ role: "user", content: "Add a cube" }],
        tools: [{ type: "function", function: { name: "arrange_objects", description: "objects", parameters: { type: "object" } } }],
        max_tokens: 15000, credential: "evil", endpoint: "https://bad.local", stream: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.tool_calls[0].function.name).toBe("arrange_objects");
    const [url, options] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((options.headers as Record<string, string>).authorization).toBe("Bearer injected-test-token");
    const outgoing = JSON.parse(options.body as string);
    expect(outgoing.model).toBe("openai/gpt-4o-mini");
    expect(outgoing.max_tokens).toBe(4096);
    expect(outgoing.tools[0].function.name).toBe("arrange_objects");
    expect(outgoing.credential).toBeUndefined();
    expect(outgoing.endpoint).toBeUndefined();
  });

  it("streams provider SSE tool-call deltas unchanged", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"arrange_objects","arguments":"{"}}]}}]}\n\n',
      'data: [DONE]\n\n'
    ].join("");
    const { app } = gateway(async () => new Response(payload, { status: 200,
      headers: { "content-type": "text/event-stream" } }));
    const response = await app.inject({ method: "POST", url: "/cozyclay/v1/chat/completions",
      payload: { model: "snarkroute/openai/gpt-4o-mini", messages: [{ role: "user", content: "scene" }], stream: true } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"tool_calls"');
    expect(response.body).toContain("data: [DONE]");
  });

  it("rejects unregistered model IDs without making a provider request", async () => {
    const { app, fetchSpy } = gateway();
    const response = await app.inject({ method: "POST", url: "/cozyclay/v1/chat/completions",
      payload: { model: "openrouter/other", messages: [{ role: "user", content: "hello" }] } });
    expect(response.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects untrusted Origin", async () => {
    const { app } = gateway();
    const response = await app.inject({ method: "GET", url: "/cozyclay/v1/models",
      headers: { origin: "https://not-local.example" } });
    expect(response.statusCode).toBe(403);
  });
});
