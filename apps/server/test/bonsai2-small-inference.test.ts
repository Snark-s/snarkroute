import { describe, expect, it, vi } from "vitest";
import { createLocalOpenAiTextNodeRunner, type LocalOpenAiConfig } from "../src/providers/local-openai";

vi.mock("../src/services/local-runtime-supervisor", () => ({
  assertLocalRuntimeAdmission: vi.fn(async () => undefined)
}));

const baseUrl = "http://127.0.0.1:8081/v1";
const config = (model: string): LocalOpenAiConfig => ({
  baseUrl, fallbackModelId: model, timeoutMs: 30_000, maxConcurrency: 1
});

async function requestBody(model: string, params: Record<string, unknown> = {}) {
  let posted: Record<string, unknown> | undefined;
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    if (String(input).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    }
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "391" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const runner = createLocalOpenAiTextNodeRunner({ config: config(model), fetchImpl });
  await runner({
    node: { id: "bonsai-test", type: "ai.text" },
    params: { providerModelId: model, prompt: "17 * 23?", ...params },
    inputs: {}, context: {}
  } as Parameters<typeof runner>[0]);
  expect(posted).toBeDefined();
  return posted!;
}

describe("Bonsai 2 small model defaults", () => {
  const path = "I:\\AI\\Bonsai-demo\\models\\bonsai2-gguf\\9B\\Ternary-Bonsai-2-9B-PQ2_0.gguf";
  it("turns thinking off and applies the PrismML non-thinking sampler for a full-path GGUF model ID", async () => {
    const payload = await requestBody(path);
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.8);
    expect(payload.presence_penalty).toBe(1.5);
    expect(payload.top_k).toBe(20);
    expect(payload.min_p).toBe(0);
    expect(payload.repeat_penalty).toBe(1);
    expect(payload.repeat_last_n).toBe(64);
  });
  it("honors explicit thinking and route sampler overrides", async () => {
    const payload = await requestBody(path, { enable_thinking: true, temperature: 0.9 });
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(payload.temperature).toBe(0.9);
    expect(payload.top_p).toBe(0.95);
  });
  it("does not change the existing 27B behavior", async () => {
    const payload = await requestBody("Ternary-Bonsai-2-27B-PQ2_0.gguf");
    expect(payload.chat_template_kwargs).toBeUndefined();
    expect(payload.temperature).toBeUndefined();
  });
});
