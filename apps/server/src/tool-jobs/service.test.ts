import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortableToolSchema } from "@snarkroute/nodes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortableToolJobService } from "./service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const tool: PortableToolSchema = {
  schemaVersion: "1.0",
  id: "example.text.tool",
  title: "Example",
  version: "1.0.0",
  action: { kind: "node", value: "example.text.tool" },
  inputs: [{ id: "prompt", type: "text", required: true, source: "manual" }],
  outputs: [{ id: "result", type: "text", placement: "new_artifact" }],
  params: [{ id: "style", type: "select", default: "plain", options: [{ value: "plain" }, { value: "bold" }] }],
  hosts: [{ host: "after_effects", sources: ["manual"], placements: ["new_artifact"] }],
  job: { states: ["queued", "starting_provider", "generating", "downloading", "completed", "failed", "cancelled"], cancellable: true, retryable: true, selectableResults: true }
};

describe("PortableToolJobService", () => {
  it("validates server catalog schema, runs asynchronously, deduplicates, and selects a result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-tool-job-")); directories.push(directory);
    const runner = vi.fn(async () => ({ status: "completed" as const, results: [{ id: "result:0", outputId: "result", type: "text" as const, label: "Result", text: "done", value: { secret: "not persisted" } }] }));
    const service = new PortableToolJobService(directory, async () => ({ tool, source: "explicit" }), runner);
    const request = { toolId: tool.id, schemaVersion: "1.0", hostType: "after_effects" as const, inputs: { prompt: { type: "text" as const, text: "hello" } }, parameters: { style: "bold" }, idempotencyKey: "ae:tool:1" };
    const created = await service.create(request);
    expect((await service.create(request)).id).toBe(created.id);
    let current = await service.get(created.id);
    for (let i = 0; i < 20 && current?.status !== "completed"; i++) { await new Promise((resolve) => setTimeout(resolve, 5)); current = await service.get(created.id); }
    expect(current).toMatchObject({ status: "completed", results: [{ id: "result:0", text: "done" }] });
    expect(JSON.stringify(current)).not.toContain("not persisted");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await service.select(created.id, "result:0")).toMatchObject({ selectedResultId: "result:0" });
  });

  it("rejects client parameters that are absent from the published schema", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-tool-validation-")); directories.push(directory);
    const service = new PortableToolJobService(directory, async () => ({ tool, source: "explicit" }), vi.fn());
    await expect(service.create({ toolId: tool.id, schemaVersion: "1.0", hostType: "after_effects", inputs: { prompt: { type: "text", text: "hello" } }, parameters: { apiKey: "client-secret" } })).rejects.toThrow("Unknown tool parameter");
  });
});
