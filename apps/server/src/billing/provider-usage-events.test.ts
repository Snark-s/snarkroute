import { describe, expect, it } from "vitest";
import { isBillableNodeResult } from "./provider-usage-events";

describe("provider usage billing guard", () => {
  it("does not bill failed KIE jobs or provider-level failures", () => {
    const failed = { nodeId: "generate", type: "ai.video.generate", status: "failed", logs: [], startedAt: "a", completedAt: "b", providerUsage: [{ provider: "kie", status: "fail" }] } as never;
    const providerFailed = { nodeId: "generate", type: "ai.video.generate", status: "succeeded", logs: [], startedAt: "a", completedAt: "b" } as never;
    expect(isBillableNodeResult(failed, "fail")).toBe(false);
    expect(isBillableNodeResult(providerFailed, "quota_exceeded")).toBe(false);
  });
});
