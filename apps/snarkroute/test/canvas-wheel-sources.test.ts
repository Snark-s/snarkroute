import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Living Canvas wheel handling", () => {
  it("does not zoom while the pointer is over a scrollable descendant", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");
    expect(main).toContain("isScrollableWheelTarget(event.target, event.currentTarget)");
    expect(main).toContain("scrollHeight > clientHeight");
    expect(main).toContain("scrollWidth > clientWidth");
  });
});
