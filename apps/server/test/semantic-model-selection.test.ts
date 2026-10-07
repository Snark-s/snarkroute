import { describe, expect, it } from "vitest";
import type { ModelOptionForNodeV1, ModelProviderRouteV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { selectSemanticModelOptionV1 } from "../src/services/semantic-model-selection";

function option(overrides: Partial<ModelOptionForNodeV1> & Pick<ModelOptionForNodeV1, "id" | "providerModelId">): ModelOptionForNodeV1 {
  return {
    id: overrides.id,
    provider: "test-provider",
    providerModelId: overrides.providerModelId,
    originVendor: "unknown",
    displayName: overrides.providerModelId,
    iconKey: "generic",
    iconPath: "",
    inputTypes: ["text", "image"],
    outputTypes: ["video"],
    capabilities: ["video.generate"],
    roles: ["generator"],
    availability: { status: "available", source: "curated", configured: true },
    parameters: [],
    catalogStatus: "known",
    nodeType: "ai.video.generate",
    storedModelId: overrides.providerModelId,
    executionProvider: overrides.provider ?? "test-provider",
    ioContract: {
      inputs: [{ kind: "text", minItems: 0, maxItems: 1 }, { kind: "image", minItems: 0, maxItems: 2 }],
      outputs: [{ kind: "video", minItems: 1, maxItems: 1 }]
    },
    ...overrides
  };
}

describe("semantic model selection over existing model options", () => {
  it("uses semantic capabilities as preferences without excluding otherwise eligible models", async () => {
    const plain = option({ id: "plain", providerModelId: "plain" });
    const camera = option({
      id: "camera",
      providerModelId: "camera",
      capabilities: ["video.generate", "video.preserve_motion"]
    });

    const result = await selectSemanticModelOptionV1([plain, camera], {
      nodeType: "ai.video.generate",
      prompt: "Preserve camera movement while replacing the actor.",
      inputs: { image: 1, video: 0, audio: 0 }
    });

    expect(result.status).toBe("ok");
    expect(result.selection?.modelId).toBe("camera");
    expect(result.models[0].id).toBe("camera");
    expect(result.requirements.preferredCapabilities).toContain("video.preserve_motion");
    expect(result.trace.eligibleEngineIds).toHaveLength(2);
    expect(result.trace.decision).toMatchObject({ invoked: true, backend: "semantic-rules" });
  });

  it("filters hard deterministic requirements before policy selection", async () => {
    const generator = option({ id: "generator", providerModelId: "generator" });
    const editor = option({
      id: "editor",
      providerModelId: "editor",
      inputTypes: ["text", "video"],
      capabilities: ["video.edit"],
      ioContract: {
        inputs: [{ kind: "text", minItems: 0, maxItems: 1 }, { kind: "video", minItems: 1, maxItems: 1 }],
        outputs: [{ kind: "video", minItems: 1, maxItems: 1 }]
      }
    });

    const result = await selectSemanticModelOptionV1([generator, editor], {
      nodeType: "ai.video.generate",
      inputs: { image: 0, video: 1, audio: 0 }
    });

    expect(result.selection?.modelId).toBe("editor");
    expect(result.requirements).toMatchObject({ operation: "edit", requiredCapabilities: ["video.edit"] });
    expect(result.trace.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ missingCapabilities: ["video.edit"] })
    ]));
  });

  it("derives the media kind for dedicated upscale nodes without requiring query input counts", async () => {
    const videoUpscaler = option({
      id: "video-upscaler",
      providerModelId: "video-upscaler",
      nodeType: "local_video_upscale",
      inputTypes: ["video"],
      capabilities: ["video.upscale"],
      roles: ["upscaler"],
      ioContract: {
        inputs: [{ kind: "video", minItems: 1, maxItems: 1 }],
        outputs: [{ kind: "video", minItems: 1, maxItems: 1 }]
      }
    });

    const result = await selectSemanticModelOptionV1([videoUpscaler], { nodeType: "local_video_upscale" });

    expect(result.status).toBe("ok");
    expect(result.requirements).toMatchObject({ domain: "upscale", operation: "upscale", requiredCapabilities: ["video.upscale"] });
  });

  it("keeps a valid manual model override ahead of semantic preferences", async () => {
    const plain = option({ id: "plain", providerModelId: "plain" });
    const camera = option({ id: "camera", providerModelId: "camera", capabilities: ["video.generate", "video.preserve_motion"] });

    const result = await selectSemanticModelOptionV1([plain, camera], {
      nodeType: "ai.video.generate",
      prompt: "Preserve camera movement.",
      manualModelRef: "plain",
      inputs: { image: 1 }
    });

    expect(result.selection?.modelId).toBe("plain");
    expect(result.trace.selectionReason).toBe("manual_override");
    expect(result.trace.decision.invoked).toBe(false);
  });

  it("returns unsupported instead of silently choosing an incapable engine", async () => {
    const result = await selectSemanticModelOptionV1([
      option({ id: "generator", providerModelId: "generator" })
    ], {
      nodeType: "ai.video.generate",
      inputs: { video: 1 }
    });

    expect(result.status).toBe("unsupported");
    expect(result.selection).toBeUndefined();
    expect(result.trace.rejected[0]).toMatchObject({ missingCapabilities: ["video.edit"] });
  });

  it("selects and promotes a concrete provider route inside a canonical model", async () => {
    const route = (provider: string, priority: number): ModelProviderRouteV1 => ({
      provider,
      providerModelId: `${provider}/camera-model`,
      storedModelId: `${provider}/camera-model`,
      availability: { status: "available", source: "live", configured: true },
      inputTypes: ["text", "image"],
      outputTypes: ["video"],
      capabilities: ["video.generate", "video.preserve_motion"],
      parameters: [],
      metadata: { priority },
      ioContract: {
        inputs: [{ kind: "text", minItems: 0, maxItems: 1 }, { kind: "image", minItems: 0, maxItems: 1 }],
        outputs: [{ kind: "video", minItems: 1, maxItems: 1 }]
      }
    });
    const canonical = option({
      id: "canonical-camera",
      providerModelId: "slow/camera-model",
      provider: "slow",
      executionProvider: "slow",
      providerRoutes: [route("slow", 1), route("fast", 10)]
    });

    const result = await selectSemanticModelOptionV1([canonical], {
      nodeType: "ai.video.generate",
      inputs: { image: 1 }
    });

    expect(result.selection).toMatchObject({ modelId: "canonical-camera", provider: "fast", providerModelId: "fast/camera-model" });
    expect(result.models[0].providerRoutes?.[0].provider).toBe("fast");
  });
});
