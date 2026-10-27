import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ModelCatalogEntryV1 } from "@snarkroute/model-catalog/dist/v1/index.js";
import { describe, expect, it } from "vitest";
import { registerModelExposureTools } from "../mcp/model-exposure-tools";
import { registerModelExposureRoutes } from "../routes/model-exposure";
import {
  assertExternalModelExposure, defaultModelExposurePolicy, groupModelExposure, modelExposureEntries,
  normalizeModelExposurePolicy, readModelExposurePolicy, writeModelExposurePolicy, type ModelExposurePolicy
} from "./model-exposure";

const entry = (provider: string, providerModelId: string, outputTypes: string[], extra: Partial<ModelCatalogEntryV1> = {}): ModelCatalogEntryV1 => ({
  id: `${provider}:${providerModelId}`, provider, providerModelId, originVendor: "unknown", displayName: providerModelId,
  iconKey: "x", iconPath: "x", inputTypes: ["text"], outputTypes: outputTypes as ModelCatalogEntryV1["outputTypes"],
  capabilities: [], roles: ["generator"], availability: { status: "available", source: "live", configured: true },
  parameters: [], catalogStatus: "known", ...extra
});
const catalog = [
  entry("flux3_native", "flux-3-image-klein", ["image"]),
  entry("qwen_edit_local", "qwen-image-edit-2511", ["image"], { roles: ["editor"] }),
  entry("openrouter", "a/text", ["text"]),
  entry("openrouter", "b/image", ["image", "text"]),
  entry("local_video_upscale", "nanovsr", ["video"], { roles: ["upscaler"] }),
  entry("local_openai", "bonsai", ["text", "json"], { availability: { status: "unavailable", source: "live", configured: true } })
];
const policy = (patch: Partial<ModelExposurePolicy>): ModelExposurePolicy => ({ ...defaultModelExposurePolicy(), ...patch });
const exposedIds = (value: ModelExposurePolicy) => modelExposureEntries(catalog, value).filter(item => item.exposed).map(item => item.id);

describe("model exposure policy", () => {
  it("exposes everything by default, only local models with localOnly", () => {
    expect(exposedIds(policy({}))).toHaveLength(catalog.length);
    expect(exposedIds(policy({ localOnly: true }))).toEqual(["flux3_native:flux-3-image-klein", "qwen_edit_local:qwen-image-edit-2511", "local_video_upscale:nanovsr", "local_openai:bonsai"]);
  });

  it("selectedOnly combines selected providers and single models, and localOnly still applies", () => {
    const selected = policy({ selectedOnly: true, providers: ["flux3_native"], models: ["openrouter:a/text"] });
    expect(exposedIds(selected)).toEqual(["flux3_native:flux-3-image-klein", "openrouter:a/text"]);
    expect(exposedIds({ ...selected, localOnly: true })).toEqual(["flux3_native:flux-3-image-klein"]);
  });

  it("groups by type, with upscalers separate and local providers first", () => {
    const groups = groupModelExposure(modelExposureEntries(catalog, policy({ localOnly: true })), policy({}));
    expect(groups.map(group => [group.type, group.modelCount, group.exposedCount])).toEqual([["text", 2, 1], ["image", 3, 2], ["upscale", 1, 1]]);
    expect(groups[1].providers.map(provider => provider.provider)).toEqual(["flux3_native", "qwen_edit_local", "openrouter"]);
  });

  it("normalizes untrusted input and persists atomically", async () => {
    expect(normalizeModelExposurePolicy({ localOnly: "yes", providers: ["a", "a", 3, " "], models: "x" })).toEqual({ ...defaultModelExposurePolicy(), providers: ["a"] });
    const path = join(await mkdtemp(join(tmpdir(), "exposure-")), "nested", "policy.json");
    expect(await readModelExposurePolicy(path)).toEqual(defaultModelExposurePolicy());
    const saved = await writeModelExposurePolicy({ localOnly: true, providers: ["flux3_native"] }, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
    expect((await readModelExposurePolicy(path)).localOnly).toBe(true);
  });

  it("rejects only MCP jobs for hidden models", async () => {
    const read = async () => policy({ selectedOnly: true, providers: ["flux3_native"] });
    const qwen = { provider: "qwen_edit_local", providerModelId: "qwen-image-edit-2511", modelId: "qwen_edit_local:qwen-image-edit-2511" };
    await expect(assertExternalModelExposure({ ...qwen, sourceContext: { client: "mcp" } }, read)).rejects.toThrow(/недоступна внешним сетям/);
    await expect(assertExternalModelExposure({ ...qwen, sourceContext: { client: "boojumroute" } }, read)).resolves.toBeUndefined();
    await expect(assertExternalModelExposure({ provider: "flux3_native", providerModelId: "flux-3-image-klein", sourceContext: { client: "mcp" } }, read)).resolves.toBeUndefined();
  });
});

describe("model exposure API and MCP tool", () => {
  it("serves grouped catalog to the local launcher and saves the policy", async () => {
    let stored = defaultModelExposurePolicy();
    const app = Fastify();
    let allow = true;
    registerModelExposureRoutes(app, () => allow, { catalog: async () => catalog, read: async () => stored, write: async value => (stored = normalizeModelExposurePolicy(value)) });
    const put = await app.inject({ method: "PUT", url: "/api/system/model-exposure", payload: { localOnly: true } });
    expect(put.json().summary).toMatchObject({ models: 6, exposedModels: 4, exposedAvailableModels: 3 });
    expect((await app.inject({ url: "/api/system/model-exposure" })).json().policy.localOnly).toBe(true);
    allow = false;
    expect((await app.inject({ method: "PUT", url: "/api/system/model-exposure", payload: {} })).statusCode).toBe(403);
    await app.close();
  });

  it("models_list returns only shared, available models", async () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerModelExposureTools(server, { catalog: async () => catalog, policy: async () => policy({ localOnly: true }) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "1" });
    await server.connect(b); await client.connect(a);
    const result = await client.callTool({ name: "models_list", arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(body.modelCount).toBe(3);
    expect(body.groups.flatMap((group: { providers: Array<{ models: Array<{ id: string }> }> }) => group.providers.flatMap(provider => provider.models.map(model => model.id))))
      .toEqual(["flux3_native:flux-3-image-klein", "qwen_edit_local:qwen-image-edit-2511", "local_video_upscale:nanovsr"]);
  });
});
