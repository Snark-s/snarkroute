import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/app";
import { __testing } from "../src/billing/pricing-service";

const ENV_KEYS = [
  "APP_MODE",
  "DATABASE_URL",
  "BOOJUM_GLOBAL_MARKUP_PERCENT",
  "BOOJUM_GLOBAL_MARKUP_CREDITS",
  "BOOJUM_MIN_CHARGE_CREDITS",
  "BOOJUM_PROVIDER_PRICING_CATALOG_JSON"
] as const;

type EnvKey = typeof ENV_KEYS[number];

const savedEnv = new Map<EnvKey, string | undefined>();

describe("/api/routes/estimate pricing baseline", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.APP_MODE = "local";
    delete process.env.DATABASE_URL;
    process.env.BOOJUM_GLOBAL_MARKUP_PERCENT = "0";
    process.env.BOOJUM_GLOBAL_MARKUP_CREDITS = "0";
    process.env.BOOJUM_MIN_CHARGE_CREDITS = "0";
    delete process.env.BOOJUM_PROVIDER_PRICING_CATALOG_JSON;
    __testing.resetLocalPricingState();
  });

  afterEach(() => {
    __testing.resetLocalPricingState();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("characterizes current final credits, free flag, pricing source, and confidence", async () => {
    const app = buildServer();
    try {
      await expectEstimate(app, "Polza Image", polzaImageRoute(), [
        { nodeId: "polza", finalCredits: 40, free: false, pricingSource: "pricing_catalog", pricingConfidence: "high" }
      ]);
      await expectEstimate(app, "Replicate Clarity Upscaler", clarityRoute(), [
        { nodeId: "upscale", finalCredits: 21, free: false, pricingSource: "pricing_catalog", pricingConfidence: "high" }
      ]);
      await expectEstimate(app, "OpenRouter Image", openRouterImageRoute(), [
        { nodeId: "image", finalCredits: 40, free: false, pricingSource: "pricing_catalog", pricingConfidence: "low" }
      ]);
      await expectEstimate(app, "Gemini Image", geminiImageRoute(), [
        { nodeId: "image", finalCredits: 67, free: false, pricingSource: "pricing_catalog", pricingConfidence: "high" }
      ]);
      await expectEstimate(app, "Polza+Clarity", polzaClarityRoute(), [
        { nodeId: "input", finalCredits: 0, free: true, pricingSource: "pricing_catalog", pricingConfidence: "high" },
        { nodeId: "polza", finalCredits: 40, free: false, pricingSource: "pricing_catalog", pricingConfidence: "high" },
        { nodeId: "upscale", finalCredits: 21, free: false, pricingSource: "pricing_catalog", pricingConfidence: "high" },
        { nodeId: "preview", finalCredits: 0, free: true, pricingSource: "pricing_catalog", pricingConfidence: "high" }
      ]);
      await expectEstimate(app, "Input/Preview/Output", freeRoute(), [
        { nodeId: "input", finalCredits: 0, free: true, pricingSource: "pricing_catalog", pricingConfidence: "high" },
        { nodeId: "preview", finalCredits: 0, free: true, pricingSource: "pricing_catalog", pricingConfidence: "high" },
        { nodeId: "output", finalCredits: 0, free: true, pricingSource: "pricing_catalog", pricingConfidence: "high" }
      ]);
    } finally {
      await app.close();
    }
  });
});

async function expectEstimate(app: ReturnType<typeof buildServer>, label: string, payload: unknown, expectedNodes: unknown[]) {
  const response = await app.inject({ method: "POST", url: "/api/routes/estimate", payload });
  expect(response.statusCode, label).toBe(200);
  expect(
    response.json().nodes.map((node: Record<string, unknown>) => ({
      nodeId: node.nodeId,
      finalCredits: node.finalCredits,
      free: node.free,
      pricingSource: node.pricingSource,
      pricingConfidence: node.pricingConfidence
    })),
    label
  ).toEqual(expectedNodes);
}

function route(id: string, nodes: unknown[], edges: unknown[] = []) {
  return {
    routeVersion: "0.1",
    route: { id, title: id, author: {} },
    nodes,
    edges
  };
}

function polzaImageRoute() {
  return route("polza-image", [
    { id: "polza", type: "polza.image.generate", title: "Polza Image", params: { model: "openai/gpt-5.4-image-2" } }
  ]);
}

function clarityRoute() {
  return route("clarity", [
    { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: { scale_factor: 2 } }
  ]);
}

function openRouterImageRoute() {
  return route("openrouter-image", [
    { id: "image", type: "ai.image.generate", title: "OpenRouter Image", params: { provider: "openrouter", model: "openai/gpt-image-1" } }
  ]);
}

function geminiImageRoute() {
  return route("gemini-image", [
    { id: "image", type: "gemini.nano-banana-2", title: "Gemini Image", params: { model: "gemini-3.1-flash-image-preview", image_resolution: "1K" } }
  ]);
}

function polzaClarityRoute() {
  return route("polza-clarity", [
    { id: "input", type: "input.image", title: "Input Image" },
    { id: "polza", type: "polza.image.generate", title: "Polza Image", params: { model: "openai/gpt-5.4-image-2" } },
    { id: "upscale", type: "replicate.clarity-upscaler", title: "Clarity Upscaler", params: { scale_factor: 2 } },
    { id: "preview", type: "preview.image", title: "Preview" }
  ], [
    { from: "input", to: "polza" },
    { from: "polza", to: "upscale" },
    { from: "upscale", to: "preview" }
  ]);
}

function freeRoute() {
  return route("free", [
    { id: "input", type: "input.image", title: "Input Image" },
    { id: "preview", type: "preview.image", title: "Preview" },
    { id: "output", type: "output.file", title: "Output" }
  ], [
    { from: "input", to: "preview" },
    { from: "preview", to: "output" }
  ]);
}
