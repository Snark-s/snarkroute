import { describe, expect, it } from "vitest";
import { exportRouteToJson, loadRouteFromYaml, parseNodeRef, parseRoute, validateRoute } from "../src/index";

const baseRoute = {
  routeVersion: "0.1",
  route: {
    id: "test-route",
    title: "Test Route",
    author: { name: "SnarkRoute" }
  },
  economics: {
    enabled: true,
    authorShare: 0.1,
    modelShares: [{ model: "owner/model", share: 0.2 }],
    notes: "Preserved from day one."
  },
  nodes: [
    { id: "input_prompt", type: "input.text", params: { value: "hello" } },
    { id: "logger", type: "unknown.node", params: {} }
  ],
  edges: [{ from: "input_prompt", to: "logger" }],
  provenance: {
    tool: "test"
  }
};

describe("protocol", () => {
  it("accepts a valid route", () => {
    expect(validateRoute(baseRoute).ok).toBe(true);
  });

  it("fails when route id is missing", () => {
    const result = validateRoute({ ...baseRoute, route: { ...baseRoute.route, id: "" } });
    expect(result.ok).toBe(false);
  });

  it("fails on duplicate node ids", () => {
    const result = validateRoute({
      ...baseRoute,
      nodes: [...baseRoute.nodes, { id: "logger", type: "debug.log" }]
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("Duplicate"))).toBe(true);
  });

  it("fails when an edge references a missing node", () => {
    const result = validateRoute({ ...baseRoute, edges: [{ from: "input_prompt", to: "missing" }] });
    expect(result.ok).toBe(false);
  });

  it("preserves economics fields", () => {
    const route = parseRoute(baseRoute);
    expect(route.economics.modelShares?.[0].model).toBe("owner/model");
    expect(exportRouteToJson(route)).toContain("authorShare");
  });

  it("allows routes without economics", () => {
    const { economics: _economics, ...withoutEconomics } = baseRoute;
    expect(validateRoute(withoutEconomics).ok).toBe(true);
  });

  it("preserves v0.1 economics metadata", () => {
    const route = parseRoute({
      ...baseRoute,
      economics: {
        enabled: true,
        mode: "metadata-only",
        currency: "USD",
        author: { id: "author", name: "Route Author", role: "route-author", share: 0.5, wallet: null, did: "did:example:123" },
        contributors: [{ id: "artist", name: "Artist", role: "artist", share: 0.25 }],
        revenueSplits: [{ recipientId: "author", share: 0.5, reason: "route authorship" }],
        providerCosts: [{ provider: "replicate", model: "owner/model", estimatedCost: null, actualCost: null }],
        notes: "metadata only",
        customField: { preserved: true }
      }
    });
    expect(route.economics?.author?.id).toBe("author");
    expect(route.economics?.customField).toEqual({ preserved: true });
    expect(exportRouteToJson(route)).toContain("revenueSplits");
  });

  it("rejects invalid share values", () => {
    expect(validateRoute({ ...baseRoute, economics: { enabled: true, author: { share: 1.1 } } }).ok).toBe(false);
    expect(validateRoute({ ...baseRoute, economics: { enabled: true, contributors: [{ id: "c", share: -0.1 }] } }).ok).toBe(false);
  });

  it("rejects revenue splits above one", () => {
    const result = validateRoute({
      ...baseRoute,
      economics: {
        enabled: true,
        mode: "metadata-only",
        revenueSplits: [
          { recipientId: "a", share: 0.7 },
          { recipientId: "b", share: 0.4 }
        ]
      }
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("revenueSplits"))).toBe(true);
  });

  it("allows metadata-only mode", () => {
    expect(validateRoute({ ...baseRoute, economics: { enabled: true, mode: "metadata-only" } }).ok).toBe(true);
  });

  it("allows unknown node types at protocol level", () => {
    expect(parseRoute(baseRoute).nodes[1].type).toBe("unknown.node");
  });

  it("rejects invalid node reference strings", () => {
    expect(() => parseNodeRef("input_prompt.output.text")).not.toThrow();
    expect(() => parseNodeRef("input_prompt.text")).toThrow(/Invalid node reference/);
  });

  it("loads YAML route files", () => {
    const route = loadRouteFromYaml(`
routeVersion: "0.1"
route:
  id: yaml-route
  title: YAML Route
  author:
    name: Tester
economics:
  enabled: false
nodes:
  - id: input_prompt
    type: input.text
edges: []
`);
    expect(route.route.id).toBe("yaml-route");
  });
});
