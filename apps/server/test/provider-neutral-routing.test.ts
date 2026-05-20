import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("provider-neutral model routing boundaries", () => {
  it("keeps OpenRouter server provider helpers free of Gemini runner imports", async () => {
    const source = await readFile(join(process.cwd(), "src", "providers", "openrouter.ts"), "utf8");
    expect(source).not.toContain("@snarkroute/gemini");
    expect(source).not.toContain("createNanoBanana2NodeRunner");
    expect(source).not.toContain("createGeminiLlmNodeRunner");
  });

  it("keeps compatibility model routing in the neutral execution module", async () => {
    const source = await readFile(join(process.cwd(), "src", "execution", "model-gateway-runners.ts"), "utf8");
    expect(source).toContain("createRemoteImageNodeRunner");
    expect(source).toContain("image.nano-banana");
    expect(source).toContain("@snarkroute/gemini");
  });
});
