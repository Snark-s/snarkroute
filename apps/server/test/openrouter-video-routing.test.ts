import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("OpenRouter video routing", () => {
  it("keeps video stack generation from regressing to Polza-only execution", async () => {
    const source = await readFile(join(process.cwd(), "src", "libraries", "service.ts"), "utf8");

    expect(source).toContain('input.executionProvider === "openrouter"');
    expect(source).toContain("runOpenRouterVideoModelForStackItem");
    expect(source).not.toContain('input.executionProvider !== "auto" && input.executionProvider !== "polza") throw new Error("Video generation is currently available through polza.ai.")');
  });
});
