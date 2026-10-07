import { describe, expect, it } from "vitest";
import { DECISION_PROTOCOL, DecisionRequestSchema, DecisionResponseSchema } from "../src/index";

describe("decision.v1 protocol", () => {
  it("accepts provider-independent structured requests", () => {
    const request = DecisionRequestSchema.parse({
      operation: "rank",
      input: { task: "Fix a TypeScript API handler" },
      candidates: [{ id: "code" }, { id: "text" }],
      constraints: { topK: 1, allowAbstain: true, confidenceThreshold: 0.7 },
      metadata: { useCase: "skill_selection" }
    });
    expect(DECISION_PROTOCOL).toBe("decision.v1");
    expect(request.candidates?.[0].id).toBe("code");
  });

  it("rejects duplicate candidate IDs", () => {
    expect(DecisionRequestSchema.safeParse({
      operation: "select_one",
      input: {},
      candidates: [{ id: "same" }, { id: "same" }]
    }).success).toBe(false);
  });

  it("rejects requests that omit the input envelope", () => {
    expect(DecisionRequestSchema.safeParse({ operation: "select_one" }).success).toBe(false);
  });

  it("accepts all normalized response states", () => {
    for (const status of ["ok", "abstain", "low_confidence", "unsupported", "timeout", "error"]) {
      expect(DecisionResponseSchema.safeParse({ status, results: [] }).success).toBe(true);
    }
  });
});
