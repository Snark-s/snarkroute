import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DecisionDispatcher,
  RulesDecisionAdapter,
  decisionCapability,
  type DecisionAdapter,
  type DecisionResponse
} from "../decision-layer";
import { ModelGateway, ModelRegistry, type ModelInfo, type ProviderAdapter } from "../model-gateway";
import {
  CapabilityMatcher,
  EngineRequirementBuilder,
  SemanticEngineSelector,
  type EngineSelectionInput
} from "./index";
import { semanticSelectionExamples } from "./examples";

describe("semantic engine selection", () => {
  it("builds video-upscale requirements from deterministic facts without invoking Decision Layer", async () => {
    const execute = vi.fn();
    const builder = new EngineRequirementBuilder(dispatcher([decisionEngine("semantic", "semantic")], [{ id: "semantic", supports: () => true, execute }]));

    const built = await builder.build({ targetDomain: "upscale", explicitOperation: "upscale", inputs: { videoCount: 1 } });

    expect(built.requirements).toMatchObject({ domain: "upscale", operation: "upscale", requiredCapabilities: ["video.upscale"] });
    expect(built.decision.invoked).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("combines video facts with semantic preserve-motion inference", async () => {
    const builder = new EngineRequirementBuilder(rulesDispatcher());
    const built = await builder.build({
      targetDomain: "video",
      inputs: { videoCount: 1 },
      prompt: "Replace the character but preserve the original camera movement"
    });

    expect(built.requirements.requiredCapabilities).toContain("video.edit");
    expect(built.requirements.preferredCapabilities).toContain("video.preserve_motion");
    expect(built.decision).toMatchObject({ invoked: true, operation: "rank", status: "ok" });
  });

  it("excludes engines missing a hard capability", () => {
    const registry = new ModelRegistry([
      engine("basic", ["video.generate"]),
      engine("editor", ["video.generate", "video.edit"])
    ]);
    const match = new CapabilityMatcher(registry).match({
      domain: "video",
      operation: "edit",
      inputs: {},
      requiredCapabilities: ["video.edit"],
      preferredCapabilities: []
    });

    expect(match.eligible.map((item) => item.id)).toEqual(["editor"]);
    expect(match.rejected).toContainEqual(expect.objectContaining({ engineId: "basic", missingCapabilities: ["video.edit"] }));
  });

  it("keeps an engine eligible when it only misses a preferred capability", () => {
    const registry = new ModelRegistry([
      engine("plain", ["video.edit"]),
      engine("motion", ["video.edit", "video.preserve_motion"])
    ]);
    const match = new CapabilityMatcher(registry).match({
      domain: "video",
      operation: "edit",
      inputs: {},
      requiredCapabilities: ["video.edit"],
      preferredCapabilities: ["video.preserve_motion"]
    });

    expect(match.eligible.map((item) => item.id).sort()).toEqual(["motion", "plain"]);
    expect(match.preferenceScores).toMatchObject({ motion: 1, plain: 0 });
  });

  it("honors manual model selection and does not silently substitute", async () => {
    const gateway = gatewayWith([
      engine("manual", ["video.edit"], 1),
      engine("higher-priority", ["video.edit", "video.preserve_motion"], 100)
    ]);
    const selector = new SemanticEngineSelector(gateway, new EngineRequirementBuilder());
    const result = await selector.select({
      targetDomain: "video",
      explicitOperation: "edit",
      inputs: { videoCount: 1 },
      manualModelRef: "model://mock/manual"
    });

    expect(result.status).toBe("ok");
    expect(result.selected?.id).toBe("manual");
    expect(result.trace.selectionReason).toBe("manual_override");
  });

  it("reports an incompatible manual override instead of choosing another eligible engine", async () => {
    const gateway = gatewayWith([
      engine("manual-generator", ["video.generate"], 1),
      engine("eligible-editor", ["video.edit"], 100)
    ]);
    const result = await new SemanticEngineSelector(gateway, new EngineRequirementBuilder()).select({
      targetDomain: "video",
      explicitOperation: "edit",
      inputs: { videoCount: 1 },
      manualModelRef: "model://mock/manual-generator"
    });

    expect(result.status).toBe("unsupported");
    expect(result.selected).toBeUndefined();
    expect(result.trace.eligibleEngineIds).toContain("eligible-editor");
    expect(result.trace.policyReasons).toContain("manual override failed capability validation");
  });

  it("returns unsupported with explainable missing capabilities", async () => {
    const gateway = gatewayWith([engine("generator", ["video.generate"])]);
    const result = await new SemanticEngineSelector(gateway, new EngineRequirementBuilder()).select({
      targetDomain: "video",
      explicitOperation: "edit",
      inputs: { videoCount: 1 },
      explicit: { requiredCapabilities: ["video.multi_reference"] }
    });

    expect(result.status).toBe("unsupported");
    expect(result.trace.eligibleEngineIds).toEqual([]);
    expect(result.trace.rejected[0]).toMatchObject({ engineId: "generator", missingCapabilities: expect.arrayContaining(["video.edit", "video.multi_reference"]) });
  });

  it("turns low-confidence semantic signals into preferences, not hard filters", async () => {
    const response: DecisionResponse = { status: "ok", results: [{ id: "video.camera_control", score: 0.31 }], confidence: 0.31 };
    const builder = new EngineRequirementBuilder(dispatcher([decisionEngine("weak", "weak")], [staticAdapter("weak", response)]), {
      hardConfidenceThreshold: 0.8,
      softConfidenceThreshold: 0.25
    });
    const built = await builder.build({ targetDomain: "video", inputs: { videoCount: 1 }, prompt: "Keep the camera path" });

    expect(built.requirements.requiredCapabilities).not.toContain("video.camera_control");
    expect(built.requirements.preferredCapabilities).toContain("video.camera_control");
  });

  it("uses Decision Dispatcher fallback during semantic enrichment", async () => {
    const fallbackResponse: DecisionResponse = { status: "ok", results: [{ id: "video.preserve_motion", score: 0.9 }], confidence: 0.9 };
    const builder = new EngineRequirementBuilder(dispatcher([
      decisionEngine("primary", "primary", 20),
      decisionEngine("fallback", "fallback", 10)
    ], [
      staticAdapter("primary", { status: "error", results: [] }),
      staticAdapter("fallback", fallbackResponse)
    ]));

    const built = await builder.build({ targetDomain: "video", inputs: { videoCount: 1 }, prompt: "Preserve motion" });
    expect(built.decision.backend).toBe("fallback");
    expect(built.requirements.requiredCapabilities).toContain("video.preserve_motion");
  });

  it("works with no specialized decision provider by using the rules backend", async () => {
    const built = await new EngineRequirementBuilder(rulesDispatcher()).build({
      targetDomain: "text",
      prompt: "Fix this TypeScript API handler"
    });
    expect(built.requirements.preferredCapabilities).toContain("text.coding");
    expect(built.decision.backend).toBe("rules-semantic");
  });

  it("keeps core selection provider-independent", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/provider\s*===?\s*["'](?:jev|needle)["']/i);
    expect(source).not.toMatch(/kling|seedance|flux/i);
  });

  it.each([
    ["text-to-image", { targetDomain: "image", inputs: {}, prompt: "Draw a fox" }, "image.generate"],
    ["image-edit", { targetDomain: "image", inputs: { imageCount: 1 }, prompt: "Change the sky" }, "image.edit"],
    ["text-to-video", { targetDomain: "video", inputs: {}, prompt: "A fox runs" }, "video.text_to_video"],
    ["image-to-video", { targetDomain: "video", inputs: { imageCount: 1 }, prompt: "Animate this" }, "video.image_to_video"],
    ["video-edit", { targetDomain: "video", inputs: { videoCount: 1 }, prompt: "Replace actor" }, "video.edit"],
    ["image-upscale", { targetDomain: "upscale", explicitOperation: "upscale", inputs: { imageCount: 1 }, constraints: { scale: 4 } }, "image.upscale"]
  ] as Array<[string, EngineSelectionInput, string]>)("preserves the %s workflow", async (_name, input, capability) => {
    const built = await new EngineRequirementBuilder().build(input);
    expect(built.requirements.requiredCapabilities).toContain(capability);
  });

  it("runs provider-independent reference, first/last-frame, and upscale smoke examples", async () => {
    const examples = await semanticSelectionExamples();
    expect(examples.referenceVideoEdit.requirements.requiredCapabilities).toEqual(expect.arrayContaining(["video.edit", "video.reference", "video.multi_reference"]));
    expect(examples.firstLastFrameVideo.requirements.requiredCapabilities).toEqual(expect.arrayContaining(["video.image_to_video", "video.first_last_frame"]));
    expect(examples.imageUpscale.requirements).toMatchObject({ domain: "upscale", constraints: { scale: 4 }, requiredCapabilities: ["image.upscale"] });
  });
});

function engine(id: string, capabilities: string[], priority = 0): ModelInfo {
  return {
    id,
    providerId: "mock",
    title: id,
    kind: capabilities[0]?.split(".")[0] ?? "utility",
    capabilities,
    priority,
    availability: "available",
    inputTypes: ["text", "image", "video"],
    outputTypes: [capabilities.some((capability) => capability.startsWith("video.")) ? "video" : "text"]
  };
}

function decisionEngine(id: string, adapterId: string, priority = 0): ModelInfo {
  return {
    id,
    providerId: adapterId,
    adapterId,
    title: id,
    kind: "decision",
    protocols: ["decision.v1"],
    capabilities: [decisionCapability("rank")],
    priority
  };
}

function staticAdapter(id: string, response: DecisionResponse): DecisionAdapter {
  return { id, supports: () => true, execute: async () => response };
}

function dispatcher(models: ModelInfo[], adapters: DecisionAdapter[]): DecisionDispatcher {
  return new DecisionDispatcher(new ModelRegistry(models), adapters);
}

function rulesDispatcher(): DecisionDispatcher {
  return dispatcher([decisionEngine("rules-semantic", "rules")], [new RulesDecisionAdapter({ id: "rules" })]);
}

function gatewayWith(models: ModelInfo[]): ModelGateway {
  const adapter: ProviderAdapter = {
    id: "mock",
    title: "Mock",
    capabilities: [...new Set(models.flatMap((model) => model.capabilities))],
    invoke: async (request) => ({ modelId: request.model.id, providerId: "mock", capability: request.capability, output: {} })
  };
  return new ModelGateway({ models, adapters: [adapter], connections: [{ providerId: "mock", enabled: true }] });
}
