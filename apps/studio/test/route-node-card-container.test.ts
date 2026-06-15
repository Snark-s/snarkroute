import { describe, expect, it } from "vitest";
import { normalizeRouteNodeCardData } from "../src/features/canvas-node/RouteNodeCardContainer";

describe("normalizeRouteNodeCardData", () => {
  it("uses routeNode fields when legacy flow data has no label", () => {
    const normalized = normalizeRouteNodeCardData("legacy-text", {
      routeNode: {
        id: "legacy-text",
        type: "input.text",
        title: "Legacy Text",
        params: { value: "hello" }
      }
    });

    expect(normalized.title).toBe("Legacy Text");
    expect(normalized.type).toBe("input.text");
    expect(normalized.params).toEqual({ value: "hello" });
  });

  it("falls back to the legacy label when routeNode is missing", () => {
    const normalized = normalizeRouteNodeCardData("legacy-custom", {
      label: "Old Custom\ncustom.legacy"
    });

    expect(normalized.title).toBe("Old Custom");
    expect(normalized.type).toBe("custom.legacy");
    expect(normalized.params).toEqual({});
  });

  it("keeps partial legacy data renderable", () => {
    const normalized = normalizeRouteNodeCardData("partial-node", {
      routeNode: {
        id: "partial-node",
        type: "input.text",
        params: []
      }
    });

    expect(normalized.title).toBe("partial-node");
    expect(normalized.type).toBe("input.text");
    expect(normalized.params).toEqual({});
  });
});
