import { describe, expect, it } from "vitest";
import { createExecutor } from "@snarkroute/executor";
import { registerBuiltInNodeRunners } from "../src/index";

describe("dialogue.workbench node", () => {
  it("runs without provider calls and exposes system plus selected outputs", async () => {
    const executor = createExecutor();
    registerBuiltInNodeRunners(executor);

    const result = await executor.executeRoute(
      {
        routeVersion: "0.1",
        route: { id: "dialogue-route", title: "Dialogue Route", author: { name: "SnarkRoute" } },
        nodes: [
          {
            id: "dialogue",
            type: "dialogue.workbench",
            params: {
              defaultModelProfileId: "text.default",
              state: {
                conversationId: "c1",
                messages: [],
                selectedOutputs: [{ id: "critique", name: "critique", type: "text", value: "Looks good.", status: "locked" }]
              }
            }
          }
        ],
        edges: []
      },
      { runId: "dialogue_test" }
    );

    expect(result.status).toBe("succeeded");
    expect(result.economics.providersUsed).toEqual([]);
    expect(result.nodeResults.dialogue.output).toMatchObject({
      critique: "Looks good.",
      conversation_json: { conversationId: "c1" },
      conversation_capsule: { conversationId: "c1" }
    });
  });
});
