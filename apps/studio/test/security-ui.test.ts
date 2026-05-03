import { describe, expect, it } from "vitest";
import { localApiUnavailableMessage, replicateTokenStatusText, serializeRouteJson } from "../src/security-ui";

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

  it("formats unreachable local API message with target URL", () => {
    expect(localApiUnavailableMessage("http://127.0.0.1:4318")).toBe(
      "Local API server is not reachable at http://127.0.0.1:4318. Run start-snarkroute.bat or start the server manually. Check VITE_API_BASE_URL if needed."
    );
  });
});
