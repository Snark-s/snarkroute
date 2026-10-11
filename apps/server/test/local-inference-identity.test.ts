import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalOpenAiTextNodeRunner, discoverLocalOpenAiModels, type LocalOpenAiConfig } from "../src/providers/local-openai";
vi.mock("../src/services/local-runtime-supervisor", () => ({ assertLocalRuntimeAdmission: vi.fn(async () => undefined) }));

afterEach(() => vi.restoreAllMocks());
const config: LocalOpenAiConfig = { baseUrl: "http://127.0.0.1:8081/v1", fallbackModelId: "bonsai.gguf", timeoutMs: 500, maxConcurrency: 1 };
const input = { node: { id: "identity", type: "ai.text" }, params: { providerModelId: "bonsai.gguf", prompt: "hello" }, inputs: {}, context: {} } as Parameters<ReturnType<typeof createLocalOpenAiTextNodeRunner>>[0];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("local inference identity checked before generation", () => {
  it("D: rejects a different HTTP service and sends no prompt POST", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => json({ service: "snarkbridge", version: "1", data: [{ id: "bonsai.gguf" }] }));
    const runner = createLocalOpenAiTextNodeRunner({ config, fetchImpl });
    await expect(runner(input)).rejects.toMatchObject({ code: "LOCAL_SERVICE_MISMATCH" });
    expect(fetchImpl.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await discoverLocalOpenAiModels({ config, fetchImpl }))[0].availability.status).toBe("unavailable");
  });

  it("D: rejects 404 and a different model at the expected endpoint", async () => {
    for (const response of [json({ error: "not found" }, 404), json({ object: "list", data: [{ id: "wrong-model", object: "model" }] })]) {
      const fetchImpl = vi.fn(async () => response.clone());
      await expect(createLocalOpenAiTextNodeRunner({ config, fetchImpl })(input)).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rechecks identity for execution, even after model discovery succeeded", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
      ? json({ choices: [{ message: { content: "safe local result" } }] })
      : json({ object: "list", data: [{ id: "bonsai.gguf", object: "model" }] }));
    await expect(createLocalOpenAiTextNodeRunner({ config, fetchImpl })(input)).resolves.toMatchObject({ output: { text: "safe local result" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: "POST", redirect: "error" });
  });
});
