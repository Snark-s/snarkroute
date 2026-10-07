import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredLocalRuntimesForTests,
  listRegisteredLocalRuntimes,
  registerLocalRuntimeEndpoint,
  registerLocalRuntimesFromModels
} from "./local-runtime-registry";

afterEach(() => clearRegisteredLocalRuntimesForTests());

describe("local runtime registry", () => {
  it("auto-registers a loopback provider from model metadata", () => {
    registerLocalRuntimesFromModels([{
      provider: "local_openai",
      providerModelId: "llama3:latest",
      displayName: "Llama 3",
      metadata: { local: true, baseUrl: "http://127.0.0.1:11434/v1" }
    }]);

    const runtimes = listRegisteredLocalRuntimes();
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]).toMatchObject({
      provider: "local_openai",
      endpoint: "http://127.0.0.1:11434/v1",
      origin: "http://127.0.0.1:11434",
      demand: "unknown",
      claimsOnStart: false
    });
    expect(runtimes[0].modelIds).toEqual(["llama3:latest"]);
  });

  it("understands provider metadata after the catalog namespaces it", () => {
    registerLocalRuntimesFromModels([{
      provider: "local_openai",
      providerModelId: "qwen3:8b",
      metadata: { provider: { local: true, baseUrl: "http://127.0.0.1:11434/v1" } }
    }]);

    expect(listRegisteredLocalRuntimes()).toEqual([expect.objectContaining({
      provider: "local_openai",
      endpoint: "http://127.0.0.1:11434/v1",
      modelIds: ["qwen3:8b"]
    })]);
  });

  it("rejects remote endpoints even when provider metadata says local", () => {
    registerLocalRuntimesFromModels([{
      provider: "custom",
      providerModelId: "x",
      metadata: { local: true, baseUrl: "https://example.com/v1" }
    }]);

    expect(listRegisteredLocalRuntimes()).toEqual([]);
  });

  it("deduplicates multiple models sharing the same local process", () => {
    registerLocalRuntimesFromModels([
      { provider: "local_openai", providerModelId: "qwen3:8b", metadata: { local: true, baseUrl: "http://localhost:11434/v1" } },
      { provider: "local_openai", providerModelId: "llama3:latest", metadata: { local: true, baseUrl: "http://localhost:11434/v1" } }
    ]);

    const runtimes = listRegisteredLocalRuntimes();
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].modelIds.sort()).toEqual(["llama3:latest", "qwen3:8b"]);
  });

  it("lets a builtin identity replace a generic endpoint identity", () => {
    registerLocalRuntimesFromModels([{
      provider: "local_openai",
      providerModelId: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
      metadata: { local: true, baseUrl: "http://localhost:8080/v1" }
    }]);

    registerLocalRuntimeEndpoint({
      id: "bonsai",
      label: "Bonsai",
      endpoint: "http://127.0.0.1:8080",
      demand: "heavy",
      claimsOnStart: true,
      source: "builtin"
    });

    expect(listRegisteredLocalRuntimes()).toEqual([expect.objectContaining({
      id: "bonsai",
      label: "Bonsai",
      demand: "heavy",
      source: "builtin",
      modelIds: ["Ternary-Bonsai-2-27B-PQ2_0.gguf"]
    })]);
  });

  it("accepts explicit runtime metadata from a future local provider", () => {
    registerLocalRuntimesFromModels([{
      provider: "super_pupyrka",
      providerModelId: "video-7b",
      metadata: {
        localRuntime: {
          id: "super-pupyrka",
          label: "Super Pupyrka",
          endpoint: "http://127.0.0.1:17777/api",
          demand: "exclusive",
          claimsOnStart: true,
          recommendedFreeVramMiB: 12288
        }
      }
    }]);

    expect(listRegisteredLocalRuntimes()[0]).toMatchObject({
      id: "super-pupyrka",
      label: "Super Pupyrka",
      demand: "exclusive",
      claimsOnStart: true,
      recommendedFreeVramMiB: 12288
    });
  });
});
