import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelResolver } from "@snarkroute/openrouter";
import { buildServer } from "../src/app";
import { createRemoteTextNodeRunner, quoteModelExecutingNode } from "../src/execution/model-gateway-runners";
import {
  createLocalOpenAiTextNodeRunner,
  localOpenAiConfig,
  localOpenAiRuntimeSnapshot
} from "../src/providers/local-openai";

const originalEnv = {
  LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
  LOCAL_LLM_API_KEY: process.env.LOCAL_LLM_API_KEY,
  LOCAL_LLM_MODEL_ID: process.env.LOCAL_LLM_MODEL_ID,
  LOCAL_LLM_TIMEOUT_MS: process.env.LOCAL_LLM_TIMEOUT_MS,
  LOCAL_LLM_MAX_CONCURRENCY: process.env.LOCAL_LLM_MAX_CONCURRENCY,
  LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON: process.env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON
};

// These tests describe the primary-only configuration, independent of installed host models.
beforeEach(() => { process.env.LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON = ""; });

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe.sequential("generic local OpenAI-compatible model route", () => {
  it("uses an inference-sized default timeout for local models", () => {
    expect(localOpenAiConfig({}).timeoutMs).toBe(600_000);
    expect(localOpenAiConfig({}).maxConcurrency).toBe(1);
  });

  it("honors a configured long-running local inference timeout", () => {
    expect(localOpenAiConfig({ LOCAL_LLM_TIMEOUT_MS: "900000" }).timeoutMs).toBe(900_000);
  });

  it("keeps the server and catalog healthy when the local endpoint is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline endpoint fixture"));
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.LOCAL_LLM_TIMEOUT_MS = "50";
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/v1?provider=local_openai" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.models).toEqual([
        expect.objectContaining({
          canonicalModelId: "bonsai-2-27b",
          provider: "local_openai",
          availability: expect.objectContaining({ status: "unavailable", reason: expect.any(String) })
        })
      ]);

      const selectorResponse = await app.inject({ method: "GET", url: "/api/models/for-node/ai.text" });
      const selectorBody = selectorResponse.json();
      const bonsai = selectorBody.models.find((model: { canonicalModelId?: string }) => model.canonicalModelId === "bonsai-2-27b");
      const route = bonsai?.providerRoutes?.find((entry: { provider: string }) => entry.provider === "local_openai");

      expect(selectorResponse.statusCode).toBe(200);
      expect(bonsai).toMatchObject({ displayName: "Bonsai 2 27B" });
      expect(route).toMatchObject({
        provider: "local_openai",
        availability: expect.objectContaining({ status: "unavailable", reason: expect.any(String) })
      });
    } finally {
      await app.close();
    }
  });

  it("discovers Bonsai and exposes its actual physical route through ai.text", async () => {
    const server = await mockOpenAiServer((request, response) => {
      if (request.url === "/v1/models") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ data: [{ id: "Ternary-Bonsai-2-27B-PQ2_0.gguf", object: "model", owned_by: "prismml" }] }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    process.env.LOCAL_LLM_BASE_URL = `${server.url}/v1`;
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/models/for-node/ai.text" });
      const body = response.json();
      const bonsai = body.models.find((model: { canonicalModelId?: string }) => model.canonicalModelId === "bonsai-2-27b");
      const route = bonsai?.providerRoutes?.find((entry: { provider: string }) => entry.provider === "local_openai");

      expect(response.statusCode).toBe(200);
      expect(bonsai).toMatchObject({
        id: "bonsai-2-27b",
        canonicalModelId: "bonsai-2-27b",
        displayName: "Bonsai 2 27B"
      });
      expect(route).toMatchObject({
        provider: "local_openai",
        providerModelId: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
        availability: { status: "available" },
        pricing: { pricing: { request: 0, prompt: 0, completion: 0 } }
      });
      expect(route.providerModelId).not.toBe(bonsai.canonicalModelId);
    } finally {
      await app.close();
      await server.close();
    }
  });

  it("executes an ordinary local chat request and records zero API cost", async () => {
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:8080/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "local answer" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runner = createRemoteTextNodeRunner(createModelResolver([]));

    const result = await runner({
      node: { id: "local", type: "ai.text" },
      params: { executionProvider: "local_openai", providerModelId: "actual-local-id", model: "bonsai-2-27b", prompt: "Hello" },
      inputs: {},
      context: {}
    } as Parameters<typeof runner>[0]);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8080/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(result.output).toMatchObject({ text: "local answer", provider: "local_openai", model: "actual-local-id", estimatedCost: 0, actualCost: 0 });
    expect(result.providerUsage).toMatchObject({ provider: "local_openai", providerModel: "actual-local-id", actualCost: 0, finalCredits: 0 });
  });

  it("uses the canvas model id as the physical local model route", async () => {
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:8080/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "canvas local answer" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runner = createRemoteTextNodeRunner(createModelResolver([]));

    const result = await runner({
      node: { id: "canvas-local", type: "ai.text" },
      params: { executionProvider: "local_openai", model: "physical-local-model.gguf", prompt: "Hello", max_tokens: 768,
        temperature: 0, response_format: { type: "json_object" } },
      inputs: {},
      context: {}
    } as Parameters<typeof runner>[0]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "physical-local-model.gguf", max_tokens: 768,
      temperature: 0, response_format: { type: "json_object" } });
    expect(result.output).toMatchObject({ text: "canvas local answer", provider: "local_openai", model: "physical-local-model.gguf" });
  });

  it("moves and coalesces system messages for strict Jinja chat templates", async () => {
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:8080/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "normalized" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runner = createRemoteTextNodeRunner(createModelResolver([]));

    await runner({
      node: { id: "local", type: "ai.text" },
      params: {
        executionProvider: "local_openai",
        providerModelId: "actual-local-id",
        messages: [
          { role: "user", content: "First user turn" },
          { role: "system", content: "Primary instructions" },
          { role: "assistant", content: "Prior answer" },
          { role: "system", content: "Task context" }
        ]
      },
      inputs: {},
      context: {}
    } as Parameters<typeof runner>[0]);

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.messages).toEqual([
      { role: "system", content: "Primary instructions\n\nTask context" },
      { role: "user", content: "First user turn" },
      { role: "assistant", content: "Prior answer" }
    ]);
  });

  it("adds a user turn when a generated text route supplies only a system prompt", async () => {
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:8080/v1";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hello" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const runner = createRemoteTextNodeRunner(createModelResolver([]));

    await runner({
      node: { id: "generated-local", type: "ai.text" },
      params: { executionProvider: "local_openai", model: "physical-local-model.gguf", systemPrompt: "Привет!" },
      inputs: {},
      context: {}
    } as Parameters<typeof runner>[0]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body)).messages).toEqual([
      { role: "system", content: "Привет!" },
      { role: "user", content: "Respond to the system instructions above." }
    ]);
  });

  it("serializes local inference and always releases the slot", async () => {
    const baseUrl = "http://127.0.0.1:18081/v1";
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return localResponse("ok");
    });
    const runner = createLocalOpenAiTextNodeRunner({
      config: { baseUrl, fallbackModelId: "bonsai.gguf", timeoutMs: 10_000, maxConcurrency: 1 },
      fetchImpl
    });
    const calls = [1, 2, 3].map((index) => runner(localInput(`queued-${index}`)));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 1, queued: 2, concurrency: 1 });
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await expect(Promise.all(calls)).resolves.toHaveLength(3);

    expect(maximumActive).toBe(1);
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 0, queued: 0 });
  });

  it("removes an aborted request from the local inference queue", async () => {
    const baseUrl = "http://127.0.0.1:18083/v1";
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetchImpl = vi.fn(async () => {
      await firstGate;
      return localResponse("ok");
    });
    const runner = createLocalOpenAiTextNodeRunner({
      config: { baseUrl, fallbackModelId: "bonsai.gguf", timeoutMs: 10_000, maxConcurrency: 1 },
      fetchImpl
    });
    const first = runner(localInput("first"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const queued = runner({ ...localInput("queued-abort"), context: { runId: "queued-abort", signal: controller.signal } });
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 1, queued: 1 });
    controller.abort(new Error("queued request cancelled"));

    await expect(queued).rejects.toThrow("queued request cancelled");
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 1, queued: 0 });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ output: { text: "ok" } });
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 0, queued: 0 });
  });

  it("releases the local inference slot after a fetch failure", async () => {
    const baseUrl = "http://127.0.0.1:18084/v1";
    const runner = createLocalOpenAiTextNodeRunner({
      config: { baseUrl, fallbackModelId: "bonsai.gguf", timeoutMs: 10_000, maxConcurrency: 1 },
      fetchImpl: vi.fn(async () => { throw new TypeError("fetch failed"); })
    });

    await expect(runner(localInput("failed"))).rejects.toThrow("fetch failed");
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 0, queued: 0 });
  });

  it("aborts the HTTP request, frees the slot, and accepts the next request", async () => {
    let first = true;
    let requestStarted!: () => void;
    let connectionClosed!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const closed = new Promise<void>((resolve) => { connectionClosed = resolve; });
    const server = await mockOpenAiServer((_request, response) => {
      if (first) {
        first = false;
        response.once("close", connectionClosed);
        requestStarted();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" } }] }));
    });
    const runner = createLocalOpenAiTextNodeRunner({
      config: { baseUrl: server.url, fallbackModelId: "bonsai.gguf", timeoutMs: 10_000, maxConcurrency: 1 }
    });
    const controller = new AbortController();
    const longRequest = runner({ ...localInput("long"), context: { runId: "long", signal: controller.signal } });
    await started;
    controller.abort(new Error("test supervisor timeout"));

    await expect(longRequest).rejects.toThrow("test supervisor timeout");
    await closed;
    expect(localOpenAiRuntimeSnapshot(server.url)).toMatchObject({ active: 0, queued: 0 });
    await expect(runner(localInput("short"))).resolves.toMatchObject({ output: { text: "recovered" } });
    expect(localOpenAiRuntimeSnapshot(server.url)).toMatchObject({ active: 0, queued: 0 });
    await server.close();
  });

  it("completes many sequential atomic-sized calls without accumulating active work", async () => {
    const baseUrl = "http://127.0.0.1:18082/v1";
    const fetchImpl = vi.fn(async () => localResponse("ok"));
    const runner = createLocalOpenAiTextNodeRunner({
      config: { baseUrl, fallbackModelId: "bonsai.gguf", timeoutMs: 10_000, maxConcurrency: 1 },
      fetchImpl
    });

    for (let index = 0; index < 50; index++) await runner(localInput(`atomic-${index}`));

    expect(fetchImpl).toHaveBeenCalledTimes(50);
    expect(localOpenAiRuntimeSnapshot(baseUrl)).toMatchObject({ active: 0, queued: 0, concurrency: 1 });
  });

  it("quotes local inference as zero external API cost", async () => {
    const quote = await quoteModelExecutingNode({
      nodeType: "ai.text",
      params: { executionProvider: "local_openai", providerModelId: "actual-local-id", model: "bonsai-2-27b" },
      modelResolver: createModelResolver([])
    });

    expect(quote.selected).toMatchObject({ provider: "local_openai", providerModel: "actual-local-id", estimatedCost: 0 });
  });
});

async function mockOpenAiServer(handler: Parameters<typeof createServer>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function localInput(id: string) {
  return {
    node: { id, type: "ai.text" },
    params: { model: "bonsai-2-27b", providerModelId: "bonsai.gguf", prompt: `Atomic request ${id}` },
    inputs: {},
    context: { runId: id }
  } as Parameters<ReturnType<typeof createLocalOpenAiTextNodeRunner>>[0];
}

function localResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
