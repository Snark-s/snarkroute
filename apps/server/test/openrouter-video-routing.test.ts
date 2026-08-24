import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("provider-neutral video routing", () => {
  it("keeps video stack generation available through OpenRouter and KIE.ai", async () => {
    const source = await readFile(join(process.cwd(), "src", "libraries", "service.ts"), "utf8");

    expect(source).toContain('input.executionProvider === "openrouter"');
    expect(source).toContain("runOpenRouterVideoModelForStackItem");
    expect(source).toContain('input.executionProvider === "kie" ? "ai.video.generate" : "polza.video.generate"');
    expect(source).toContain("polza.ai, OpenRouter, or KIE.ai");
    expect(source).not.toContain('input.executionProvider !== "auto" && input.executionProvider !== "polza") throw new Error("Video generation is currently available through polza.ai.")');
  });
});
