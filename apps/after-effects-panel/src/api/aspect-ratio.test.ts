import { describe, expect, it } from "vitest";
import { applyCompositionAspectRatioDefault, compositionAspectRatio } from "./aspect-ratio";

const schema = [{ id: "aspect_ratio", label: "Aspect ratio", type: "select" as const, required: true, options: ["1:1", "16:9", "9:16"].map((value) => ({ value })) }];

describe("composition aspect ratio defaults", () => {
  it.each([[1920, 1080, "16:9"], [1080, 1920, "9:16"], [1024, 1024, "1:1"]])("maps %sx%s to %s", (width, height, expected) => {
    expect(compositionAspectRatio(width as number, height as number)).toBe(expected);
  });

  it("requires explicit selection for a non-standard composition ratio", () => {
    expect(compositionAspectRatio(1200, 800)).toBeUndefined();
  });

  it("does not overwrite a user's selection", () => {
    expect(applyCompositionAspectRatioDefault(schema, { aspect_ratio: "1:1" }, { width: 1920, height: 1080 })).toEqual({ aspect_ratio: "1:1" });
  });
});
