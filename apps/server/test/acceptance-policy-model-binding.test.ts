import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app";
import * as policy from "../src/services/model-routing-policy";

// Acceptance regression: the model checked by the paid-permission policy must be the model sent to the provider.
vi.mock("../src/services/local-runtime-supervisor", () => ({ assertLocalRuntimeAdmission: vi.fn(async () => undefined) }));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.stubEnv("APP_MODE", "local");
  vi.stubEnv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8081/v1");
  vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", "");
  for (const key of ["GEMINI_API_KEY", "POLZA_AI_API_KEY", "KIE_API_KEY", "RUTRONIX_API_KEY", "EXPERIENTIAL_API_KEY", "EXPERIENTIAL_API_BASE_URL", "FAL_KEY", "H3_WORKER_URL"]) vi.stubEnv(key, "");
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-key-for-mocked-transport");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.sequential("paid policy is bound to the executed model", () => {
  it("does not authorize one model and execute another", async () => {
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("openrouter.ai") && init?.method === "POST") {
        sent.push(String(JSON.parse(String(init.body)).model));
        return json({ id: "x", choices: [{ message: { content: "fixture" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      return json({ error: "offline fixture" }, 503);
    });
    const checked: string[] = [];
    const real = policy.assertModelInvocationPolicy;
    vi.spyOn(policy, "assertModelInvocationPolicy").mockImplementation(async (provider, model, params, nodeType, load) => {
      checked.push(`${provider}/${model}`);
      // Treat only the decoy as confirmed free so the test does not depend on the live pricing cache.
      if (model === "fixture/free-decoy:free") return;
      return real(provider, model, params, nodeType, load);
    });
    const app = buildServer();
    const run = (routingPolicy?: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/routes/run", payload: {
      routeVersion: "1.0", route: { id: "binding", title: "binding", author: {} }, edges: [],
      nodes: [{ id: "llm", type: "ai.text", params: { prompt: "hello", providerMode: "openrouter", model: "openai/gpt-4o",
        providerModelId: "fixture/free-decoy:free", ...(routingPolicy ? { routingPolicy } : {}) } }]
    } }).then(response => response.json());
    try {
      const denied = await run();
      // Whatever was sent upstream must have been the model that passed the policy check.
      for (const model of sent) expect(checked).toContain(`openrouter/${model}`);
      expect(denied.status).toBe("failed");
      expect(denied.nodeResults.llm.errorDetails.code).toBe("PAID_PERMISSION_REQUIRED");
      expect(sent).toEqual([]);

      const approved = await run({ allowPaid: true });
      expect(approved.status).toBe("succeeded");
      expect(sent).toEqual(["openai/gpt-4o"]);
    } finally { await app.close(); }
  });
});
