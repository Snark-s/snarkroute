import { describe, expect, it } from "vitest";
import {
  buildDialogueWorkbenchOutputs,
  generateConversationCapsule,
  generateConversationJson,
  generateConversationText,
  normalizeDialogueWorkbenchState,
  parseModelProfile,
  validateModelProfile,
  type DialogueWorkbenchState
} from "../src/index";

const state: DialogueWorkbenchState = {
  conversationId: "conversation-1",
  defaultModelProfileId: "text.default",
  messages: [
    {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "Make a crystalline bridge prompt." }],
      createdAt: "2026-05-15T10:00:00.000Z",
      pinned: true
    },
    {
      id: "m2",
      role: "assistant",
      content: [{ type: "text", text: "Final prompt draft." }],
      createdAt: "2026-05-15T10:01:00.000Z",
      modelProfileId: "text.default",
      actualProviderId: "openrouter",
      actualModelId: "openai/example",
      params: { temperature: 0.2 },
      costEstimate: 0.001,
      selectedAsOutput: true
    }
  ],
  selectedOutputs: [
    {
      id: "final_prompt",
      name: "final_prompt",
      type: "text",
      sourceMessageId: "m2",
      value: "Final prompt draft.",
      status: "locked"
    }
  ]
};

describe("ModelProfile validation", () => {
  it("validates portable model metadata without credentials", () => {
    const profile = parseModelProfile({
      id: "openrouter:gpt",
      displayName: "GPT via OpenRouter",
      providerId: "openrouter",
      modelId: "openai/example",
      capabilities: ["text", "json_output"],
      costClass: "medium",
      privacyClass: "external"
    });

    expect(profile.providerId).toBe("openrouter");
    expect(JSON.stringify(profile)).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("reports invalid model profiles", () => {
    const result = validateModelProfile({ id: "", displayName: "Missing provider", modelId: "x", capabilities: ["text"] });
    expect(result.ok).toBe(false);
  });
});

describe("Dialogue Workbench portable outputs", () => {
  it("normalizes serialized state safely", () => {
    const normalized = normalizeDialogueWorkbenchState(JSON.parse(JSON.stringify(state)), { nodeId: "dialogue" });
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.selectedOutputs[0]).toMatchObject({ id: "final_prompt", status: "locked" });
  });

  it("generates readable conversation_text", () => {
    const text = generateConversationText({
      nodeTitle: "Prompt Dialogue",
      state,
      inputs: [{ id: "brief", type: "text", value: "Short brief" }],
      modelProfiles: [{ id: "text.default", displayName: "Default Text", providerId: "openrouter", modelId: "openai/example", capabilities: ["text"] }]
    });

    expect(text).toContain("# Dialogue: Prompt Dialogue");
    expect(text).toContain("Model: Default Text / openrouter / openai/example");
    expect(text).toContain("final_prompt");
  });

  it("generates full conversation_json with model metadata", () => {
    const json = generateConversationJson({ nodeId: "dialogue_1", nodeTitle: "Dialogue", state, inputs: [] });
    expect(json).toMatchObject({ conversationId: "conversation-1", nodeId: "dialogue_1" });
    expect(JSON.stringify(json)).toContain("actualProviderId");
    expect(JSON.stringify(json)).not.toMatch(/api[_-]?key|secret|token/i);
  });

  it("generates compact conversation_capsule from pinned and selected material", () => {
    const capsule = generateConversationCapsule({ nodeId: "dialogue_1", state, now: "2026-05-15T10:02:00.000Z" });
    expect(capsule.compactSummary).toContain("Make a crystalline bridge prompt.");
    expect(capsule.selectedOutputs).toHaveLength(1);
  });

  it("exposes locked selected outputs as dynamic output fields", () => {
    const outputs = buildDialogueWorkbenchOutputs({ nodeId: "dialogue_1", nodeTitle: "Dialogue", state, inputs: {} });
    expect(outputs.final_prompt).toBe("Final prompt draft.");
    expect(outputs.conversation_text).toContain("Selected Outputs");
    expect(outputs.conversation_json).toMatchObject({ conversationId: "conversation-1" });
    expect(outputs.conversation_capsule.selectedOutputs).toHaveLength(1);
  });
});
