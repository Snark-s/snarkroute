import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas note persistence", () => {
  it("saves a changed note when pointer selection deactivates it before blur", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

    expect(source).toContain("wasActive.current && !active");
    expect(source).toContain('textNode?.manifest.variant === "note"');
    expect(source).toContain("onSaveText(textNode.manifest.id, draftText)");
  });
});
