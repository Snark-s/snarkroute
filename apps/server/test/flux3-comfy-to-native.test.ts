import { describe, expect, it } from "vitest";
import { FLUX3_NATIVE_SCRIPT, nativeFlux3Configured, referencePaths, validateDimension, validateInteger } from "../src/providers/flux3-native";

describe("FLUX.3 native Diffusers (no ComfyUI)", () => {
  it("is strictly opt-in", () => {
    expect(nativeFlux3Configured({})).toBe(false);
    expect(nativeFlux3Configured({ FLUX3_NATIVE_ENABLED: "true" })).toBe(false);
    expect(nativeFlux3Configured({ FLUX3_NATIVE_ENABLED: "1" })).toBe(true);
  });
  it("rejects dimensions that risk unbounded VRAM use", () => {
    expect(validateDimension(undefined, 512)).toBe(512);
    expect(validateDimension(1024, 512)).toBe(1024);
    expect(() => validateDimension(1025, 512)).toThrow("multiple of 16");
    expect(() => validateDimension(8192, 512)).toThrow("multiple of 16");
  });
  it("validates seeds and step counts", () => {
    expect(validateInteger(16, 16, 1, 50)).toBe(16);
    expect(() => validateInteger(-1, 0, 0, 2147483647)).toThrow();
    expect(() => validateInteger(0, 16, 1, 50)).toThrow();
  });
  it("accepts image descriptors and never arbitrary extensions or many references", () => {
    expect(referencePaths([])).toEqual([]);
    expect(referencePaths({ localPath: "a.png" })[0]).toMatch(/a\.png$/);
    expect(() => referencePaths("x.exe")).toThrow("PNG");
    expect(() => referencePaths(new Array(11).fill("x.png"))).toThrow("ten");
  });
  it("points at a local Python worker, not ComfyUI", () => {
    expect(FLUX3_NATIVE_SCRIPT.replaceAll("\\", "/")).toMatch(/workers\/flux3-native\/infer\.py$/);
  });
});
