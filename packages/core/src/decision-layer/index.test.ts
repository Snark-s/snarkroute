import { describe, expect, it, vi } from "vitest";
import { ModelGateway, ModelRegistry, type ModelInfo, type ProviderAdapter } from "../model-gateway";
import {
  DECISION_PROTOCOL,
  DecisionDispatcher,
  ModelGatewayDecisionAdapter,
  RulesDecisionAdapter,
  decisionCapability,
  type DecisionAdapter,
  type DecisionRequest,
  type DecisionResponse
} from "./index";
import { runDecisionLayerExample } from "./example";

const candidates = [
  { id: "image", metadata: { keywords: ["draw", "picture"] } },
  { id: "video", metadata: { keywords: ["movie", "clip"] } },
  { id: "text", metadata: { keywords: ["write", "article"] } },
  { id: "code", metadata: { keywords: ["typescript", "api", "handler"] } }
];

describe("Decision Layer decision.v1", () => {
  it("registers decision engines in the existing registry without breaking non-decision models", () => {
    const registry = new ModelRegistry([
      textModel,
      decisionEngine("rules-main", "rules", ["select_one", "rank"])
    ]);

    expect(registry.findByProtocol(DECISION_PROTOCOL).map((engine) => engine.id)).toEqual(["rules-main"]);
    expect(registry.findByCapability("text.generate").map((engine) => engine.id)).toEqual(["text-main"]);
    expect(registry.listEngines()).toHaveLength(2);
  });

  it("discovers a backend by operation capability", () => {
    const registry = new ModelRegistry([
      decisionEngine("ranker", "ranker-adapter", ["rank"]),
      decisionEngine("classifier", "classifier-adapter", ["classify"])
    ]);
    const dispatcher = new DecisionDispatcher(registry, [staticAdapter("ranker-adapter", ok("a"))]);

    expect(dispatcher.findBackends("rank").map((engine) => engine.id)).toEqual(["ranker"]);
  });

  it("selects one candidate through the rules backend", async () => {
    const dispatcher = rulesDispatcher(["select_one"]);
    const response = await dispatcher.execute(request("select_one", "Fix a TypeScript API handler"));

    expect(response).toMatchObject({ status: "ok", results: [{ id: "code" }], backend: "rules-main" });
  });

  it("ranks candidates and respects topK", async () => {
    const dispatcher = rulesDispatcher(["rank"]);
    const response = await dispatcher.execute({
      ...request("rank", "Create an API handler and write an article"),
      constraints: { topK: 2 }
    });

    expect(response.status).toBe("ok");
    expect(response.results.map((result) => result.id)).toEqual(["text", "code"]);
  });

  it("returns unsupported when no engine has the requested capability", async () => {
    const dispatcher = rulesDispatcher(["rank"]);
    await expect(dispatcher.execute(request("extract", "Find a date"))).resolves.toMatchObject({ status: "unsupported", results: [] });
  });

  it("allows a rules backend to abstain", async () => {
    const dispatcher = rulesDispatcher(["select_one"]);
    await expect(dispatcher.execute({
      ...request("select_one", "Unrelated request"),
      constraints: { allowAbstain: true }
    })).resolves.toMatchObject({ status: "abstain", results: [] });
  });

  it("normalizes an ok response below the confidence threshold to low_confidence", async () => {
    const registry = new ModelRegistry([decisionEngine("weak", "weak", ["score"])]);
    const dispatcher = new DecisionDispatcher(registry, [staticAdapter("weak", { ...ok("code"), confidence: 0.2 })]);

    await expect(dispatcher.execute({
      ...request("score", "code"),
      constraints: { confidenceThreshold: 0.8 }
    })).resolves.toMatchObject({ status: "low_confidence", confidence: 0.2 });
  });

  it("normalizes adapter timeouts", async () => {
    const registry = new ModelRegistry([decisionEngine("slow", "slow", ["rank"])]);
    const slow: DecisionAdapter = {
      id: "slow",
      supports: () => true,
      execute: () => new Promise(() => undefined)
    };
    const dispatcher = new DecisionDispatcher(registry, [slow], { fallback: { timeoutMs: 5 } });

    await expect(dispatcher.execute(request("rank", "anything"))).resolves.toMatchObject({ status: "timeout", backend: "slow" });
  });

  it("falls back to the next configured backend on error", async () => {
    const observed = vi.fn();
    const registry = new ModelRegistry([
      decisionEngine("primary", "primary", ["rank"], 20),
      decisionEngine("secondary", "secondary", ["rank"], 10)
    ]);
    const dispatcher = new DecisionDispatcher(registry, [
      staticAdapter("primary", { status: "error", results: [] }),
      staticAdapter("secondary", ok("code"))
    ], { onObservation: observed });

    const response = await dispatcher.execute(request("rank", "code"));
    expect(response).toMatchObject({ status: "ok", backend: "secondary" });
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ fallbackCount: 1, fallbackPath: ["primary", "secondary"] }));
  });

  it("works without specialized providers by falling back to rules", async () => {
    const registry = new ModelRegistry([decisionEngine("rules-main", "rules", ["select_one"])]);
    const dispatcher = new DecisionDispatcher(registry, [new RulesDecisionAdapter({ id: "rules" })]);

    await expect(dispatcher.execute(request("select_one", "Fix a TypeScript API handler"))).resolves.toMatchObject({ status: "ok", backend: "rules-main" });
  });

  it("uses the existing Model Gateway as a generic LLM backend", async () => {
    const invoke = vi.fn(async (input: Parameters<ProviderAdapter["invoke"]>[0]) => ({
      modelId: input.model.id,
      providerId: input.model.providerId,
      capability: input.capability,
      output: { status: "ok", results: [{ id: "code", score: 0.9 }], confidence: 0.9 }
    }));
    const gateway = new ModelGateway({
      models: [textModel],
      adapters: [{ id: "llm", title: "LLM", capabilities: ["text.generate"], invoke }],
      connections: [{ providerId: "llm", enabled: true }]
    });
    const registry = gateway.registry;
    registry.register(decisionEngine("generic-llm-decision", "model-gateway", ["rank"], 1, { modelRef: "model://llm/text-main" }));
    const dispatcher = new DecisionDispatcher(registry, [new ModelGatewayDecisionAdapter(gateway)]);

    await expect(dispatcher.execute(request("rank", "Fix a TypeScript API handler"))).resolves.toMatchObject({ status: "ok", results: [{ id: "code" }] });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("ignores disabled or unavailable backends", async () => {
    const disabled = decisionEngine("disabled", "disabled", ["rank"], 100);
    disabled.availability = "unavailable";
    const registry = new ModelRegistry([disabled, decisionEngine("enabled", "enabled", ["rank"], 1)]);
    const disabledExecute = vi.fn(async () => ok("image"));
    const dispatcher = new DecisionDispatcher(registry, [
      { id: "disabled", supports: () => true, execute: disabledExecute },
      staticAdapter("enabled", ok("code"))
    ]);

    await expect(dispatcher.execute(request("rank", "code"))).resolves.toMatchObject({ backend: "enabled" });
    expect(disabledExecute).not.toHaveBeenCalled();
  });

  it("does not loop when fallback policy repeats an engine", async () => {
    const execute = vi.fn(async () => ({ status: "error", results: [] } as DecisionResponse));
    const registry = new ModelRegistry([decisionEngine("only", "only", ["rank"])]);
    const dispatcher = new DecisionDispatcher(registry, [{ id: "only", supports: () => true, execute }], {
      fallback: { engineIds: ["only", "only", "only"], maxAttempts: 10 }
    });

    await expect(dispatcher.execute(request("rank", "code"))).resolves.toMatchObject({ status: "error" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps existing non-decision gateway invocation behavior", async () => {
    const gateway = new ModelGateway({
      models: [textModel],
      adapters: [{
        id: "llm",
        title: "LLM",
        capabilities: ["text.generate"],
        invoke: async (input) => ({ modelId: input.model.id, providerId: "llm", capability: input.capability, output: { text: "ok" } })
      }],
      connections: [{ providerId: "llm", enabled: true }]
    });

    await expect(gateway.invoke({ capability: "text.generate", input: { prompt: "hello" } })).resolves.toMatchObject({ modelId: "text-main", output: { text: "ok" } });
  });

  it("runs the provider-neutral decision smoke example", async () => {
    await expect(runDecisionLayerExample()).resolves.toMatchObject({ status: "ok", results: [{ id: "code" }] });
  });
});

const textModel: ModelInfo = {
  id: "text-main",
  providerId: "llm",
  title: "Text Main",
  kind: "text",
  capabilities: ["text.generate"]
};

function decisionEngine(id: string, adapterId: string, operations: Array<DecisionRequest["operation"]>, priority = 0, metadata?: Record<string, unknown>): ModelInfo {
  return {
    id,
    providerId: adapterId,
    adapterId,
    title: id,
    kind: "decision",
    protocols: [DECISION_PROTOCOL],
    capabilities: operations.map(decisionCapability),
    priority,
    metadata
  };
}

function request(operation: DecisionRequest["operation"], input: string): DecisionRequest {
  return { operation, input: { text: input }, candidates };
}

function ok(id: string): DecisionResponse {
  return { status: "ok", results: [{ id, score: 1 }], confidence: 1 };
}

function staticAdapter(id: string, response: DecisionResponse): DecisionAdapter {
  return { id, supports: () => true, execute: async () => response };
}

function rulesDispatcher(operations: Array<DecisionRequest["operation"]>): DecisionDispatcher {
  const registry = new ModelRegistry([decisionEngine("rules-main", "rules", operations)]);
  return new DecisionDispatcher(registry, [new RulesDecisionAdapter({ id: "rules" })]);
}
