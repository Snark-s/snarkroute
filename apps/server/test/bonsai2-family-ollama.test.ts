import { describe, expect, it, vi } from "vitest";
import {
  BONSAI2_OLLAMA_MODEL_IDS,
  discoverLocalOpenAiModels,
  localOpenAiConfigs
} from "../src/providers/local-openai";
import { localServiceUrl } from "../src/services/local-service-endpoints";

const experimental = { BONSAI2_OLLAMA_EXPERIMENTAL: "1" };

describe("Bonsai 2 family via experimental local Ollama", () => {
  it("never automatically enables an unverified runtime", () => {
    const configs = localOpenAiConfigs({});
    expect(configs).toHaveLength(1);
    expect(configs[0].baseUrl).toBe(localServiceUrl("bonsai_inference", "/v1"));
  });

  it("offers four allowlisted routes only when experimental use is explicitly enabled", () => {
    const configs = localOpenAiConfigs(experimental);
    expect(configs[0].baseUrl).toBe(localServiceUrl("bonsai_inference", "/v1"));
    expect(configs[1]).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: undefined,
      optionalDiscovery: true,
      modelIds: [...BONSAI2_OLLAMA_MODEL_IDS]
    });
  });

  it("preserves and extends an explicitly configured Ollama allowlist", () => {
    const configs = localOpenAiConfigs({
      ...experimental,
      LOCAL_LLM_ADDITIONAL_ENDPOINTS_JSON:
        '[{"baseUrl":"http://127.0.0.1:11434/v1","modelIds":["qwen3:8b"]}]'
    });
    expect(configs).toHaveLength(2);
    expect(configs[1].modelIds).toEqual(["qwen3:8b", ...BONSAI2_OLLAMA_MODEL_IDS]);
  });

  it("does not duplicate Ollama when Ollama is already the primary runtime", () => {
    const configs = localOpenAiConfigs({
      ...experimental,
      LOCAL_LLM_BASE_URL: "http://127.0.0.1:11434/v1"
    });
    expect(configs).toHaveLength(1);
  });

  it("exposes only installed physical model IDs and preserves size-specific names", async () => {
    const config = localOpenAiConfigs(experimental)[1];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      object: "list", data: [{ id: "bonsai-2:9b" }, { id: "other-local:latest" }]
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const models = await discoverLocalOpenAiModels({ config, fetchImpl });
    expect(models.map(model => model.providerModelId)).toEqual(["bonsai-2:9b"]);
    expect(models[0]).toMatchObject({
      canonicalModelId: "bonsai-2-9b",
      displayName: "Bonsai 2 9B",
      availability: { status: "available" }
    });
  });

  it("does not present an offline optional Ollama as installed", async () => {
    const config = localOpenAiConfigs(experimental)[1];
    const models = await discoverLocalOpenAiModels({
      config, fetchImpl: vi.fn().mockRejectedValue(new Error("local endpoint unavailable")) as typeof fetch
    });
    expect(models).toEqual([]);
  });
});
