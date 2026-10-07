import { ModelRegistry, type ModelInfo } from "../model-gateway";
import { DECISION_PROTOCOL, DecisionDispatcher, RulesDecisionAdapter, decisionCapability } from "./index";

const rulesEngine: ModelInfo = {
  id: "rules-example",
  providerId: "rules",
  adapterId: "rules",
  title: "Deterministic rules example",
  kind: "decision",
  protocols: [DECISION_PROTOCOL],
  capabilities: [decisionCapability("select_one")],
  availability: "available",
  priority: 1
};

export async function runDecisionLayerExample() {
  const registry = new ModelRegistry([rulesEngine]);
  const dispatcher = new DecisionDispatcher(registry, [new RulesDecisionAdapter()]);

  return dispatcher.execute({
    operation: "select_one",
    input: { text: "Fix a TypeScript API handler" },
    candidates: [
      { id: "image", metadata: { keywords: ["draw", "picture"] } },
      { id: "video", metadata: { keywords: ["movie", "clip"] } },
      { id: "text", metadata: { keywords: ["write", "article"] } },
      { id: "code", metadata: { keywords: ["typescript", "api", "handler"] } }
    ],
    constraints: { allowAbstain: true }
  });
}
