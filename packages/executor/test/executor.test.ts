import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenRoute } from "@snarkroute/protocol";
import { createExecutor, detectCycles, resolveTemplates, topologicalSort } from "../src/index";

function route(overrides: Partial<OpenRoute> = {}): OpenRoute {
  return {
    routeVersion: "0.1",
    route: { id: "r", title: "R", author: {} },
    economics: { enabled: false },
    nodes: [
      { id: "a", type: "input.text", params: { value: "hello" } },
      { id: "b", type: "transform.template", params: { template: "{{a.output.text}} world" } }
    ],
    edges: [{ from: "a", to: "b" }],
    ...overrides
  };
}

describe("executor", () => {
  it("executes a simple linear graph", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    executor.registerNodeRunner("transform.template", ({ params }) => ({ output: { text: params.template } }));
    const result = await executor.executeRoute(route(), { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) });
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.b.output).toEqual({ text: "hello world" });
  });

  it("executes a branching graph", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    executor.registerNodeRunner("debug.log", ({ inputs }) => ({ output: { value: inputs } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "a", type: "input.text", params: { value: "x" } },
          { id: "b", type: "debug.log" },
          { id: "c", type: "debug.log" }
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" }
        ]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(Object.keys(result.nodeResults)).toHaveLength(3);
  });

  it("executes according to edge order even when nodes are listed out of order", async () => {
    const executor = createExecutor();
    const seen: string[] = [];
    executor.registerNodeRunner("first", ({ node }) => {
      seen.push(node.id);
      return { output: { value: "a" } };
    });
    executor.registerNodeRunner("second", ({ node }) => {
      seen.push(node.id);
      return { output: { value: "b" } };
    });
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "b", type: "second" },
          { id: "a", type: "first" }
        ],
        edges: [{ from: "a", to: "b" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(seen).toEqual(["a", "b"]);
  });

  it("detects cycles", () => {
    const cyclic = route({ edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
    expect(detectCycles(cyclic)).toEqual(["a", "b", "a"]);
    expect(() => topologicalSort(cyclic)).toThrow(/cycle/i);
  });

  it("fails clearly when a runner is missing", async () => {
    const result = await createExecutor().executeRoute(route(), { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) });
    expect(result.status).toBe("failed");
    expect(result.logs.at(-1)?.message).toContain("No runner registered");
  });

  it("resolves template references", () => {
    expect(resolveTemplates("Say {{input_prompt.output.text}}", { input_prompt: { text: "hi" } })).toBe("Say hi");
  });

  it("fails clearly when a template references a missing node", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("transform.template", ({ params }) => ({ output: { text: params.template } }));
    const result = await executor.executeRoute(
      route({
        nodes: [{ id: "b", type: "transform.template", params: { template: "{{missing.output.text}}" } }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.logs.at(-1)?.message).toContain("missing node");
  });

  it("fails clearly when a template references a missing output field", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", () => ({ output: { text: "hi" } }));
    executor.registerNodeRunner("transform.template", ({ params }) => ({ output: { text: params.template } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "a", type: "input.text" },
          { id: "b", type: "transform.template", params: { template: "{{a.output.missing}}" } }
        ],
        edges: [{ from: "a", to: "b" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.b.error).toContain("missing output field");
  });

  it("fails clearly when a template dependency is missing an edge", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", () => ({ output: { text: "hi" } }));
    executor.registerNodeRunner("transform.template", ({ params }) => ({ output: { text: params.template } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "a", type: "input.text" },
          { id: "b", type: "transform.template", params: { template: "{{a.output.text}}" } }
        ],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.logs.at(-1)?.message).toContain("has no edge");
  });

  it("persists run.json to the run folder", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "sr-"));
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    executor.registerNodeRunner("transform.template", ({ context }) => {
      return { output: { path: join(context.outputDirectory, "out.txt") } };
    });
    const result = await executor.executeRoute(route(), { outputDirectory });
    const saved = JSON.parse(await readFile(join(result.outputDirectory, "run.json"), "utf8"));
    expect(saved.status).toBe("succeeded");
  });
});
