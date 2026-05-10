import { describe, expect, it } from "vitest";
import { exportRouteToJson, parseRoute } from "../src/index";

describe("route export secret stripping", () => {
  it("does not include API keys in exported routes", () => {
    const route = parseRoute({
      routeVersion: "0.1",
      route: { id: "secret-test", title: "Secret Test", author: { name: "SnarkRoute" } },
      nodes: [
        {
          id: "text",
          type: "ai.text",
          params: {
            prompt: "hello",
            openRouterApiKey: "sk-or-secret"
          }
        }
      ],
      edges: []
    });
    const exported = exportRouteToJson(route);
    expect(exported).not.toContain("sk-or-secret");
    expect(exported).not.toContain("openRouterApiKey");
    expect(exported).toContain("hello");
  });

  it("loads old remote route nodes without providerMode", () => {
    expect(() => parseRoute({
      routeVersion: "0.1",
      route: { id: "old-route", title: "Old Route", author: { name: "SnarkRoute" } },
      nodes: [{ id: "llm", type: "gemini.llm", params: { model: "gemini-2.5-flash-lite", prompt: "hello" } }],
      edges: []
    })).not.toThrow();
  });
});
