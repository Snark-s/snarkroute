import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  afterEach(() => {
    delete process.env.BOOJUM_GLOBAL_MARKUP_PERCENT;
    delete process.env.BOOJUM_GLOBAL_MARKUP_CREDITS;
    delete process.env.BOOJUM_MIN_CHARGE_CREDITS;
    delete process.env.BOOJUM_PRICING_OVERRIDES_JSON;
    delete process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON;
  });

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

  it("skips preview nodes when an upstream provider node fails", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", () => {
      throw new Error("Insufficient credits: need 40, balance 20.");
    });
    executor.registerNodeRunner("preview.image", () => {
      throw new Error("preview should not run without an upstream image");
    });
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "polza", type: "polza.image.generate", title: "Polza Image" },
          { id: "preview", type: "preview.image", title: "Image Preview" }
        ],
        edges: [{ from: "polza", to: "preview", fromPort: "image", toPort: "image" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.polza.status).toBe("failed");
    expect(result.nodeResults.preview.status).toBe("skipped");
    expect(result.nodeResults.preview.error).toBe("Skipped because upstream node failed: Polza Image");
    expect(result.nodeResults.preview.actualCredits).toBe(0);
  });

  it("does not charge a paid provider node that throws before a billable result", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", () => {
      throw new Error("Polza.ai account has insufficient funds.");
    });
    const result = await executor.executeRoute(
      route({
        nodes: [{ id: "polza", type: "polza.image.generate", title: "Polza Image" }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.polza.status).toBe("failed");
    expect(result.nodeResults.polza.error).toBe("Polza.ai account has insufficient funds. No credits were charged.");
    expect(result.nodeResults.polza.actualCredits).toBe(0);
    expect(result.costSummary.totalEstimatedCredits).toBe(40);
    expect(result.costSummary.totalActualCredits).toBe(0);
    expect(result.costSummary.refundedCredits).toBe(40);
  });

  it("treats provider error usage without an artifact as non-billable", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", ({ node }) => ({
      output: {},
      providerUsage: { provider: "polza", model: "image-model", nodeId: node.id, nodeType: node.type, status: "error" }
    }));
    const result = await executor.executeRoute(
      route({
        nodes: [{ id: "polza", type: "polza.image.generate", title: "Polza Image" }],
        edges: []
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("failed");
    expect(result.nodeResults.polza.status).toBe("failed");
    expect(result.nodeResults.polza.actualCredits).toBe(0);
    expect(result.nodeResults.polza.providerUsage?.[0]).toMatchObject({ status: "error" });
    expect(result.costSummary.totalActualCredits).toBe(0);
  });

  it("prices provider nodes from microusd catalog and integer markup", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", () => ({ output: { image: { path: "out.png", mimeType: "image/png" } } }));
    const noMarkup = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate", params: { model: "gpt-5.4-image-2" } }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(noMarkup.costSummary.estimates[0].baseCostMicrousd).toBe(40000);
    expect(noMarkup.costSummary.estimates[0].baseCredits).toBe(40);
    expect(noMarkup.costSummary.totalEstimatedCredits).toBe(40);

    process.env.BOOJUM_GLOBAL_MARKUP_PERCENT = "25";
    const globalPercent = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate" }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(globalPercent.costSummary.totalEstimatedCredits).toBe(50);

    process.env.BOOJUM_GLOBAL_MARKUP_PERCENT = "0";
    process.env.BOOJUM_GLOBAL_MARKUP_CREDITS = "5";
    const globalAbsolute = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate" }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(globalAbsolute.costSummary.totalEstimatedCredits).toBe(45);

    process.env.BOOJUM_GLOBAL_MARKUP_CREDITS = "0";
    process.env.BOOJUM_PRICING_OVERRIDES_JSON = JSON.stringify([{ provider: "polza", operation: "image.generate", markupPercent: 10, markupCredits: 3, enabled: true }]);
    const nodeOverride = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate" }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(nodeOverride.costSummary.totalEstimatedCredits).toBe(47);
  });

  it("uses model-specific provider pricing before generic Polza fallback", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", () => ({ output: { image: { path: "out.png", mimeType: "image/png" } } }));
    process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON = JSON.stringify([
      { provider: "polza", operation: "image.generate", model: "polza/cheap-image", baseCostMicrousd: 20000, currency: "USD", effectiveFrom: "2026-01-01", source: "test_catalog" },
      { provider: "polza", operation: "image.generate", model: "polza/expensive-image", baseCostMicrousd: 120000, currency: "USD", effectiveFrom: "2026-01-01", source: "test_catalog" }
    ]);

    const cheap = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate", params: { model: "polza/cheap-image" } }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    const expensive = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate", params: { model: "polza/expensive-image" } }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );

    expect(cheap.costSummary.totalEstimatedCredits).toBe(20);
    expect(expensive.costSummary.totalEstimatedCredits).toBe(120);
    expect(cheap.costSummary.estimates[0].model).toBe("polza/cheap-image");
    expect(expensive.costSummary.estimates[0].model).toBe("polza/expensive-image");
  });

  it("uses Polza tier pricing rules from imageResolution params", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", () => ({ output: { image: { path: "out.png", mimeType: "image/png" } } }));
    process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON = JSON.stringify([
      { provider: "polza", operation: "image.generate", model: "openai/gpt-5.4-image-2", parameterRules: { image_resolution: "1K" }, baseCostMicrousd: 40000, currency: "USD", effectiveFrom: "2026-01-01", source: "test_catalog" },
      { provider: "polza", operation: "image.generate", model: "openai/gpt-5.4-image-2", parameterRules: { image_resolution: "2K" }, baseCostMicrousd: 70000, currency: "USD", effectiveFrom: "2026-01-01", source: "test_catalog" }
    ]);

    const oneK = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate", params: { model: "openai/gpt-5.4-image-2", imageResolution: "1K" } }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    const twoK = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate", params: { model: "openai/gpt-5.4-image-2", imageResolution: "2K" } }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );

    expect(oneK.costSummary.totalEstimatedCredits).toBe(40);
    expect(twoK.costSummary.totalEstimatedCredits).toBe(70);
  });

  it("keeps free preview nodes at zero credits", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("preview.image", () => ({ output: { ok: true } }));
    const result = await executor.executeRoute(
      route({ nodes: [{ id: "preview", type: "preview.image" }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.costSummary.totalEstimatedCredits).toBe(0);
    expect(result.costSummary.estimates[0].pricingBreakdown?.free).toBe(true);
  });

  it("caps actual provider cost charges at maxChargeCredits", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("polza.image.generate", ({ node }) => ({
      output: { image: { path: "out.png", mimeType: "image/png" } },
      providerUsage: { provider: "polza", nodeId: node.id, nodeType: node.type, status: "succeeded", actualCost: 1, actualCostCurrency: "USD" }
    }));
    const result = await executor.executeRoute(
      route({ nodes: [{ id: "polza", type: "polza.image.generate" }], edges: [] }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.costSummary.totalEstimatedCredits).toBe(40);
    expect(result.costSummary.totalActualCredits).toBe(40);
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

  it("fans one compound input out to multiple internal targets", async () => {
    const executor = createExecutor();
    executor.registerNodeRunner("input.text", ({ params }) => ({ output: { text: params.value } }));
    executor.registerNodeRunner("debug.log", ({ inputs }) => ({ output: { value: inputs } }));
    const result = await executor.executeRoute(
      route({
        nodes: [
          { id: "prefix", type: "input.text", params: { value: "hello" } },
          {
            id: "compound",
            type: "compound.subroute",
            compound: {
              inputs: [{ id: "text", nodeId: "left", port: "value", targets: [{ nodeId: "left", port: "value" }, { nodeId: "right", port: "value" }] }],
              outputs: [{ id: "left", nodeId: "left", port: "value" }, { id: "right", nodeId: "right", port: "value" }]
            },
            subroute: route({
              route: { id: "sub", title: "Sub", author: {} },
              nodes: [{ id: "left", type: "debug.log" }, { id: "right", type: "debug.log" }],
              edges: []
            })
          }
        ],
        edges: [{ from: "prefix", to: "compound", fromPort: "text", toPort: "text" }]
      }),
      { outputDirectory: await mkdtemp(join(tmpdir(), "sr-")) }
    );
    expect(result.status).toBe("succeeded");
    expect(result.nodeResults.compound.output).toEqual({ left: { value: "hello" }, right: { value: "hello" } });
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
