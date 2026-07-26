import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas generation error display", () => {
  it("keeps long provider errors readable inside the node", () => {
    const styles = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    const errorRule = styles.match(/\.promptMeta \.generationStatus\.isError\s*\{([^}]+)\}/)?.[1] ?? "";

    expect(errorRule).toContain("max-height: 132px");
    expect(errorRule).toContain("overflow-y: auto");
    expect(errorRule).toContain("overflow-wrap: anywhere");
    expect(errorRule).not.toContain("overflow: hidden");
  });
});
