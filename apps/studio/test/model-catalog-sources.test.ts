import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function studioSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url)), "utf8");
}

describe("Studio model catalog sources", () => {
  it("does not define static Polza provider model option arrays", () => {
    const config = studioSource("studioConfig.ts");
    expect(config).not.toContain("POLZA_TEXT_MODEL_OPTIONS");
    expect(config).not.toContain("POLZA_IMAGE_MODEL_OPTIONS");
    expect(config).not.toContain("POLZA_VIDEO_MODEL_OPTIONS");
  });

  it("does not use legacy or raw provider model endpoints in normal Studio model loading", () => {
    const main = studioSource("main.tsx");
    const catalogClient = studioSource("modelCatalogClient.ts");
    const source = `${main}\n${catalogClient}`;

    expect(source).not.toContain("/api/models?");
    expect(source).not.toContain("/api/providers/openrouter/models");
    expect(source).not.toContain("/api/providers/polza/models");
    expect(source).not.toContain("fallbackModels");
    expect(source).not.toContain("POLZA_TEXT_MODEL_OPTIONS");
    expect(source).not.toContain("POLZA_IMAGE_MODEL_OPTIONS");
    expect(source).not.toContain("POLZA_VIDEO_MODEL_OPTIONS");
  });

  it("shows the RuTronix missing-key action and Settings links", () => {
    const main = studioSource("main.tsx");
    const card = studioSource("features/canvas-node/RouteNodeCardContainer.tsx");
    expect(card).toContain("Requires RuTronix API key");
    expect(card).toContain("Configure RuTronix");
    expect(card).toContain("RUTRONIX_API_KEY: onConfigureRutronix");
    expect(main).toContain('id="rutronix-api-key-input"');
    expect(main).toContain('providerLinks.rutronix?.apiKeysUrl');
  });

  it("offers a RuTronix preset backed by ai.text catalog options without adding a node type", () => {
    const main = studioSource("main.tsx");
    expect(main).toContain('modelOptionsForNodes["ai.text"]');
    expect(main).toContain('executionProvider === "rutronix"');
    expect(main).toContain('RuTronix catalog preset');
    expect(main).not.toContain('type: "rutronix.');
  });
});
