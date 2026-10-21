import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { GenerationJob, GenerationJobRequest } from "../model-gateway-jobs/service";
import { registerImageTools } from "./image-tools";

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function harness(finalStatus: "completed" | "failed" = "completed") {
  const dir = await mkdtemp(join(tmpdir(), "img-tools-"));
  const resultPath = join(dir, "out.png");
  const refPath = join(dir, "ref.png");
  await writeFile(resultPath, PNG); await writeFile(refPath, PNG);
  const created: GenerationJobRequest[] = [];
  let polls = 0;
  const job = (status: string): GenerationJob => ({
    id: "gen_0000aaaa-1111-2222-3333-444455556666", status: status as GenerationJob["status"], request: created[0],
    createdAt: "t", updatedAt: "t",
    ...(status === "completed" ? { result: { path: resultPath, filename: "out.png", mimeType: "image/png", provider: "flux3_native", modelId: "m", estimatedCost: 0, actualCost: 0 }, costs: { providerCost: 0, baseCost: 0, markup: null, finalCredits: null } } : {}),
    ...(status === "failed" ? { error: "CUDA OOM" } : {})
  });
  const jobs = {
    create: async (request: GenerationJobRequest) => { created.push(request); return job("queued"); },
    get: async () => job(++polls < 3 ? "generating" : finalStatus),
    cancel: async () => job("cancelled")
  };
  const server = new McpServer({ name: "t", version: "1" });
  registerImageTools(server, jobs as never, async () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "1" });
  await server.connect(b); await client.connect(a);
  return { client, created, refPath, resultPath };
}

describe("image MCP tools", () => {
  it("lists the image tools", async () => {
    const { client } = await harness();
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["image_generate", "image_job", "image_cancel", "image_view"]));
  });

  it("submits an edit through the Model Gateway, waits, and returns a preview image", async () => {
    const { client, created, refPath } = await harness();
    const result = await client.callTool({ name: "image_generate", arguments: { prompt: "fox", references: [refPath], seed: 7, waitSeconds: 30 } }) as { content: Array<{ type: string; mimeType?: string; text?: string }> };
    expect(created[0]).toMatchObject({ capability: "image.edit", nodeType: "ai.image.generate", provider: "flux3_native", providerModelId: "flux-3-image-klein", parameters: { width: 512, height: 512, steps: 16, seed: 7 } });
    expect(created[0].inputs?.[0]).toMatchObject({ kind: "image", role: "reference", path: refPath });
    expect(JSON.parse(result.content[0].text!).job.status).toBe("completed");
    expect(result.content.some(item => item.type === "image")).toBe(true);
  });

  it("reports failures as tool errors", async () => {
    const { client } = await harness("failed");
    const result = await client.callTool({ name: "image_generate", arguments: { prompt: "fox", waitSeconds: 30 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("CUDA OOM");
  });

  it("refuses relative or non-image paths", async () => {
    const { client } = await harness();
    expect((await client.callTool({ name: "image_view", arguments: { path: "out.png" } })).isError).toBe(true);
    expect((await client.callTool({ name: "image_view", arguments: { path: "C:\\Windows\\win.ini" } })).isError).toBe(true);
  });

  it("views a local image", async () => {
    const { client, resultPath } = await harness();
    const result = await client.callTool({ name: "image_view", arguments: { path: resultPath } }) as { content: Array<{ type: string }> };
    expect(result.content.map(item => item.type)).toEqual(["text", "image"]);
  });
});
