import { describe, expect, it } from "vitest";
import { chooseBuzhaSubscription } from "./models";
describe("Buzha model catalog selection", () => {
  it("reads normalized provider hints and preserves an eligible configured model", () => {
    const models = [{ id: "default", name: "default", provider: "chatgpt_subscription", providerModelId: "default", metadata: { provider: { qualityHint: "high", priority: 75 } } }, { id: "chosen", name: "chosen", provider: "chatgpt_subscription", providerModelId: "chosen", metadata: { provider: { qualityHint: "high", priority: 70 } } }];
    expect(chooseBuzhaSubscription(models, "chatgpt_subscription")?.id).toBe("default"); expect(chooseBuzhaSubscription(models, "chatgpt_subscription", "chosen")?.id).toBe("chosen");
  });
  it("does not silently choose a paid API or a lower-quality role", () => {
    const models = [{ id: "paid", name: "Codex", provider: "openrouter", providerModelId: "model", metadata: { provider: { qualityHint: "high", priority: 100 } } }, { id: "small", name: "small", provider: "chatgpt_subscription", providerModelId: "small", metadata: { provider: { qualityHint: "medium" } } }];
    expect(chooseBuzhaSubscription(models, "chatgpt_subscription")).toBeUndefined(); expect(chooseBuzhaSubscription(models, "openrouter")).toBeUndefined();
  });
});
