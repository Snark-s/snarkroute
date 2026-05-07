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

  it("passes explicit edge ports into named inputs", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("source", () => ({ output: { image: { path: "image.png" }, output: { raw: true } } }));
    executor.registerNodeRunner("sink", ({ inputs }) => ({ output: { value: inputs } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "upscale", type: "source" },
          { id: "preview", type: "sink" },
          { id: "file", type: "sink" }
        ],
        edges: [
          { from: "upscale", to: "preview", fromPort: "image", toPort: "image" },
          { from: "upscale", to: "file", fromPort: "output", toPort: "from" }
        ]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.nodeResults.preview.output).toEqual({ value: { image: { path: "image.png" } } });
    expect(result.nodeResults.file.output).toEqual({ value: { from: { image: { path: "image.png" }, output: { raw: true } } } });
  });

  it("passes asset-shaped outputs through image ports", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.image", () => ({ output: { path: "local.png", mimeType: "image/png" } }));
    executor.registerNodeRunner("consumer", ({ inputs }) => ({ output: { image: inputs.image } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "input", type: "input.image" },
          { id: "consume", type: "consumer" }
        ],
        edges: [{ from: "input", to: "consume", fromPort: "image", toPort: "image" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.nodeResults.consume.output).toEqual({ image: { path: "local.png", mimeType: "image/png" } });
  });

  it("collects multiple edges into the same named input as an array", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.image", ({ node }) => ({ output: { path: `${node.id}.png`, mimeType: "image/png" } }));
    executor.registerNodeRunner("consumer", ({ inputs }) => ({ output: { images: inputs.images } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "first", type: "input.image" },
          { id: "second", type: "input.image" },
          { id: "consume", type: "consumer" }
        ],
        edges: [
          { from: "first", to: "consume", fromPort: "image", toPort: "images" },
          { from: "second", to: "consume", fromPort: "image", toPort: "images" }
        ]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.nodeResults.consume.output).toEqual({
      images: [
        { path: "first.png", mimeType: "image/png" },
        { path: "second.png", mimeType: "image/png" }
      ]
    });
  });

  it("uses initial node outputs without rerunning seeded upstream nodes", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("source", () => {
      throw new Error("seeded source should not run");
    });
    executor.registerNodeRunner("consumer", ({ inputs }) => ({ output: { image: inputs.image } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "source", type: "source" },
          { id: "consume", type: "consumer" }
        ],
        edges: [{ from: "source", to: "consume", fromPort: "image", toPort: "image" }]
      }),
      {
        outputDirectory: await mkdtemp(join(tmpdir(), "sr-")),
        initialNodeOutputs: { source: { image: { path: "ready.png", mimeType: "image/png" } } }
      }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.source.logs).toEqual(["Using existing output"]);
    expect(result.nodeResults.consume.output).toEqual({ image: { path: "ready.png", mimeType: "image/png" } });
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

  it("includes economics summary with paymentExecuted false", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    const result = await executor.executeRoute(
      route({ nodes: [{ id: "a", type: "input.text", params: { value: "hello" } }], edges: [], economics: undefined }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.economics.mode).toBe("disabled");
    expect(result.economics.paymentExecuted).toBe(false);
    expect(JSON.stringify(result.economics)).not.toContain("token");
  });

  it("collects provider usage from node runners", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("replicate.model", ({ node }) => ({
      output: { ok: true },
      providerUsage: {
        provider: "replicate",
        model: "owner/model",
        nodeId: node.id,
        nodeType: node.type,
        externalId: "prediction-1",
        status: "succeeded",
        pricingHint: "external-provider-billing",
        actualCost: null,
        estimatedCost: null
      }
    }));
    const result = await executor.executeRoute(
      route({
        economics: { enabled: true, mode: "accounting-only", currency: "USD" },
        nodes: [{ id: "model", type: "replicate.model" }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.economics.providersUsed[0]).toMatchObject({ provider: "replicate", model: "owner/model", externalId: "prediction-1" });
    expect(result.economics.costSummary.actualProviderCost).toBeNull();
  });

  it("executes a capability node through a selected provider", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("provider.image", ({ node, params, inputs }) => ({
      output: { image: { path: "generated.png" }, prompt: params.prompt, inputPrompt: inputs.prompt },
      providerUsage: { provider: "test", model: "image-model", nodeId: node.id, nodeType: node.type, status: "succeeded" }
    }));
    executor.registerCapabilityProvider("image.create", "provider.image");
    const result = await executor.executeRoute(
      route({
        nodes: [{ id: "make", type: "capability.image.create", params: { prompt: "a tiny moon" } }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.make.output).toMatchObject({ image: { path: "generated.png" }, prompt: "a tiny moon" });
    expect(result.nodeResults["make/make__provider"].type).toBe("provider.image");
    expect(result.economics.providersUsed[0]).toMatchObject({ nodeId: "make__provider", nodeType: "provider.image" });
  });

  it("fails clearly when an explicit capability provider is unavailable", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("provider.image", () => ({ output: { ok: true } }));
    executor.registerCapabilityProvider("image.create", "provider.image");
    const result = await executor.executeRoute(
      route({
        nodes: [{ id: "make", type: "capability.image.create", params: { provider: "missing.provider" } }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.make.error).toContain("does not declare support");
  });

  it("executes a compound subroute and exposes mapped outputs", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    executor.registerNodeRunner("transform.template", ({ params }) => ({ output: { text: params.template } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "prefix", type: "input.text", params: { value: "hello" } },
          {
            id: "compound",
            type: "compound.subroute",
            compound: {
              inputs: [{ id: "text", nodeId: "inner", port: "template" }],
              outputs: [{ id: "text", nodeId: "inner", port: "text" }]
            },
            subroute: route({
              route: { id: "sub", title: "Sub", author: {} },
              nodes: [{ id: "inner", type: "transform.template", params: { template: "{{compound__input__text.output.value}} world" } }],
              edges: [{ from: "compound__input__text", to: "inner" }]
            })
          }
        ],
        edges: [{ from: "prefix", to: "compound", fromPort: "text", toPort: "text" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compound.output).toEqual({ text: "hello world" });
    expect(result.nodeResults["compound/inner"].status).toBe("succeeded");
  });

  it("identifies the failed internal node for compound subroutes", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("explode", () => {
      throw new Error("boom");
    });
    const result = await executor.executeRoute(
      route({
        nodes: [
          {
            id: "compound",
            type: "compound.subroute",
            compound: { outputs: [{ id: "value", nodeId: "inner", port: "value" }] },
            subroute: route({ route: { id: "sub", title: "Sub", author: {} }, nodes: [{ id: "inner", type: "explode" }], edges: [] })
          }
        ],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.compound.error).toContain('internal node "inner"');
    expect(result.nodeResults["compound/inner"].error).toContain("boom");
  });

  it("appends a local run ledger entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sr-ledger-"));
    const ledgerPath = join(directory, "runs.jsonl");
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", () => ({ output: { text: "hello" } }));
    const result = await executor.executeRoute(route({ nodes: [{ id: "a", type: "input.text" }], edges: [] }), {
      outputDirectory: join(directory, "run"),
      ledgerPath
    });
    const ledger = await readFile(ledgerPath, "utf8");
    expect(ledger).toContain(result.runId);
    expect(ledger).toContain('"paymentExecuted":false');
    expect(ledger).not.toMatch(/token|secret/i);
  });
});
