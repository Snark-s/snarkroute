import { describe, expect, it } from "vitest";
import { clampMenuPosition } from "./menuPosition";

describe("clampMenuPosition", () => {
  const menu = { width: 180, height: 120 };
  const viewport = { width: 1000, height: 700 };

  it("keeps a menu at the requested point when it fits", () => {
    expect(clampMenuPosition({ x: 200, y: 150 }, menu, viewport)).toEqual({ x: 200, y: 150 });
  });

  it("flips left at the right edge", () => {
    expect(clampMenuPosition({ x: 950, y: 150 }, menu, viewport).x).toBe(770);
  });

  it("flips up at the bottom edge", () => {
    expect(clampMenuPosition({ x: 200, y: 680 }, menu, viewport).y).toBe(560);
  });

  it("clamps an oversized menu to the viewport margin", () => {
    expect(clampMenuPosition({ x: 500, y: 350 }, { width: 1200, height: 800 }, viewport)).toEqual({ x: 8, y: 8 });
  });
});
