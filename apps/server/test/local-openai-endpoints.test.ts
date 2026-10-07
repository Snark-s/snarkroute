import { afterEach, expect, it, vi } from "vitest";
import { discoverLocalOpenAiModels, createLocalOpenAiTextNodeRunner, localOpenAiConfigs } from "../src/providers/local-openai";

afterEach(() => vi.unstubAllEnvs());

it("discovers only explicitly allowed additional local models and routes without moving Bonsai or forwarding its key", async () => {
  vi.stubEnv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080/v1");
  vi.stubEnv("LOCAL_LLM_API_KEY", "bonsai-secret");
  vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", JSON.stringify([{ baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3:8b"], reasoningEffort: "none" }]));
  const calls: Array<{url: string; init: RequestInit}> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(String(url).endsWith("/models")
      ? { data: [{ id: String(url).includes("11434") ? "qwen3:8b" : "bonsai.gguf" }, { id: "cloud:cloud" }] }
      : { choices: [{ message: { content: "ok" } }] }));
  });
  const models = await discoverLocalOpenAiModels({ fetchImpl });
  expect(models.some(model => model.providerModelId === "qwen3:8b")).toBe(true);
  expect(models.filter(model => model.metadata?.baseUrl === "http://127.0.0.1:11434/v1").map(model => model.providerModelId)).toEqual(["qwen3:8b"]);
  const runner = createLocalOpenAiTextNodeRunner({ fetchImpl });
  for (const providerModelId of ["qwen3:8b", "bonsai.gguf"]) await runner({ node: { id: "test", type: "ai.text" }, params: { providerModelId, prompt: "test" }, inputs: {}, context: {} } as Parameters<typeof runner>[0]);
  const chat = calls.filter(call => call.url.endsWith("/chat/completions"));
  expect(chat.map(call => call.url)).toEqual(["http://127.0.0.1:11434/v1/chat/completions", "http://127.0.0.1:8080/v1/chat/completions"]);
  expect(new Headers(chat[0].init.headers).has("authorization")).toBe(false);
  expect(new Headers(chat[1].init.headers).get("authorization")).toBe("Bearer bonsai-secret");
  expect(JSON.parse(String(chat[0].init.body))).toHaveProperty("reasoning_effort", "none");
  expect(JSON.parse(String(chat[1].init.body))).not.toHaveProperty("reasoning_effort");
});

it("fails closed on invalid, duplicate or cloud endpoint/model configuration", () => {
  for (const entry of [
    [{ baseUrl: "https://ollama.com/v1", modelIds: ["qwen3:8b"] }],
    [{ baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["deepseek:cloud"] }],
    [{ baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3:8b", "qwen3:8b"] }]
  ]) expect(() => localOpenAiConfigs({ LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON: JSON.stringify(entry) })).toThrow();
});

it("does not fall back to the primary endpoint after an additional model fails", async () => {
  vi.stubEnv("LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON", JSON.stringify([{ baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3:8b"] }]));
  const fetchImpl = vi.fn(async () => new Response("model unavailable", { status: 503 }));
  const runner = createLocalOpenAiTextNodeRunner({ fetchImpl });
  await expect(runner({ node: { id: "test", type: "ai.text" }, params: { providerModelId: "qwen3:8b", prompt: "test" }, inputs: {}, context: {} } as Parameters<typeof runner>[0])).rejects.toThrow("HTTP 503");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/chat/completions", expect.anything());
});
it("requires explicit allowlisted native tool confirmation independently of model discovery", () => {
  const config = { baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen3:8b"] };
  expect(localOpenAiConfigs({ LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON: JSON.stringify([config]) })[1].nativeToolModelIds).toBeUndefined();
  expect(localOpenAiConfigs({ LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON: JSON.stringify([{ ...config, nativeToolModelIds: ["qwen3:8b"] }]) })[1].nativeToolModelIds).toEqual(["qwen3:8b"]);
  for (const nativeToolModelIds of [["unknown"], "qwen3:8b", [null]]) {
    expect(() => localOpenAiConfigs({ LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON: JSON.stringify([{ ...config, nativeToolModelIds }]) })).toThrow("allowlisted");
  }
});
