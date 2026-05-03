import { describe, expect, it } from "vitest";
import { replicateTokenStatusText, serializeRouteJson } from "../src/security-ui";

describe("Replicate token UX helpers", () => {
  it("can display missing and configured token status", () => {
    expect(replicateTokenStatusText(false)).toBe("Replicate token: missing");
    expect(replicateTokenStatusText(true)).toBe("Replicate token: configured");
  });

  it("route export does not contain local token state", () => {
    const token = "test-secret-token";
    const routeJson = serializeRouteJson({
      routeVersion: "0.1",
      route: { id: "route", title: "Route", author: {} },
      nodes: [{ id: "upscale", type: "replicate.clarity-upscaler", params: { prompt: "hi" } }],
      edges: []
    });

    expect(routeJson).not.toContain(token);
    expect(routeJson).not.toContain("REPLICATE_API_TOKEN");
  });
});
