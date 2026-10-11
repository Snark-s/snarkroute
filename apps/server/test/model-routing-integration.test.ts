import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app";

vi.mock("../src/services/local-runtime-supervisor", () => ({ assertLocalRuntimeAdmission: vi.fn(async () => undefined) }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.stubEnv("APP_MODE", "local");
  vi.stubEnv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8081/v1");
  vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", "");
  for (const key of ["GEMINI_API_KEY", "POLZA_AI_API_KEY", "OPENROUTER_API_KEY", "KIE_API_KEY", "RUTRONIX_API_KEY", "EXPERIENTIAL_API_KEY", "EXPERIENTIAL_API_BASE_URL", "FAL_KEY", "H3_WORKER_URL"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function route(params: Record<string, unknown>, type = "ai.text") {
  return { routeVersion: "1.0", route: { id: "routing-integration", title: "Routing integration", author: {} },
    nodes: [{ id: "llm", type, params: { prompt: "Create a bounded Blender plan", ...params } }], edges: [] };
}

describe.sequential("model routing API integration without real paid requests", () => {
  it("A: chooses and executes an available local route without any cloud generation POST", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === "http://127.0.0.1:8081/v1/models") return json({ object: "list", data: [{ id: "bonsai-fixture.gguf", object: "model" }] });
      if (String(url) === "http://127.0.0.1:8081/v1/chat/completions") return json({ choices: [{ message: { content: "fixture plan" } }] });
      return json({ error: "unavailable fixture" }, 503);
    });
    const app = buildServer();
    try {
      const selected = (await app.inject({ method: "GET", url: "/api/models/for-node/ai.text?prompt=plan" })).json().semanticSelection.selection;
      expect(selected).toMatchObject({ provider: "local_openai", providerModelId: "bonsai-fixture.gguf" });
      const response = (await app.inject({ method: "POST", url: "/api/routes/run", payload: route({}) })).json();
      expect(response.status).toBe("succeeded");
      expect(response.nodeResults.llm.output).toMatchObject({ text: "fixture plan", actualCost: 0 });
      const posts = fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0][0]).toBe("http://127.0.0.1:8081/v1/chat/completions");
    } finally { await app.close(); }
  });

  it("B: fails with a policy explanation and performs no generation POST when local/free is unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: "offline fixture" }, 503));
    const app = buildServer();
    try {
      const selection = (await app.inject({ method: "GET", url: "/api/models/for-node/ai.text" })).json().semanticSelection;
      expect(selection.status).toBe("unsupported");
      expect(selection.errorCode).toMatch(/PAID_PERMISSION_REQUIRED|NO_PERMITTED_MODEL_ROUTE/);
      const result = (await app.inject({ method: "POST", url: "/api/routes/run", payload: route({}) })).json();
      expect(result.status).toBe("failed");
      expect(result.nodeResults.llm.errorDetails.code).toMatch(/PAID_PERMISSION_REQUIRED|NO_PERMITTED_MODEL_ROUTE/);
      expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    } finally { await app.close(); }
  });

  it("C: preserves provider 402 origin in run JSON and avoids repeated calls to a known depleted provider", async () => {
    vi.stubEnv("POLZA_AI_API_KEY", "fixture-key-for-mocked-transport");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ error: { message: "Provider balance is empty", code: "insufficient_balance" } }, 402));
    const app = buildServer();
    try {
      const request = { method: "POST" as const, url: "/api/routes/run", payload: route({ model: "openai/fixture", routingPolicy: { allowPaid: true } }, "polza.text") };
      const first = (await app.inject(request)).json();
      expect(first.status).toBe("failed");
      expect(first.nodeResults.llm).toMatchObject({ errorCode: "provider_insufficient_funds", providerId: "polza",
        errorDetails: { code: "PROVIDER_INSUFFICIENT_FUNDS", retryable: false, details: { origin: "provider", providerId: "polza", statusCode: 402 } } });
      const postCount = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").length;
      expect(postCount).toBe(1);
      const second = (await app.inject(request)).json();
      expect(second.nodeResults.llm.errorDetails.code).toBe("PROVIDER_BALANCE_UNAVAILABLE");
      expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(postCount);
    } finally { await app.close(); }
  });

  it("D: detects another service on the LLM endpoint and sends it no generation body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ service: "snarkbridge", version: "1" }));
    const app = buildServer();
    try {
      const result = (await app.inject({ method: "POST", url: "/api/routes/run", payload: route({ executionProvider: "local_openai", providerModelId: "bonsai-fixture.gguf" }) })).json();
      expect(result.status).toBe("failed");
      expect(result.nodeResults.llm.errorDetails.code).toBe("LOCAL_SERVICE_MISMATCH");
      expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    } finally { await app.close(); }
  });
});
