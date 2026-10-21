import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createQwenEditNodeRunner, fitSize, runQwenEditJob } from "./qwen-edit-local";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function fakeServer(final: "completed" | "failed") {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  let polls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/sdcpp/v1/img_gen")) return new Response(JSON.stringify({ id: "j1", status: "queued", poll_url: "/sdcpp/v1/jobs/j1" }), { status: 202 });
    if (url.endsWith("/sdcpp/v1/jobs/j1")) {
      polls++;
      if (polls < 2) return new Response(JSON.stringify({ id: "j1", status: "generating" }));
      return new Response(JSON.stringify(final === "completed"
        ? { id: "j1", status: "completed", result: { output_format: "png", images: [{ index: 0, b64_json: PNG.toString("base64") }] } }
        : { id: "j1", status: "failed", error: { message: "out of memory" } }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, deps: { fetchImpl, sleep: async () => undefined, baseUrl: "http://127.0.0.1:8094", skipRuntime: true } };
}

describe("qwen-edit-local provider", () => {
  it("fits the source into <=1024 px multiples of 16", () => {
    expect(fitSize(2000, 1000)).toEqual({ width: 1024, height: 512 });
    expect(fitSize(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it("submits ref images to sd-server's native queue, polls, and writes the PNG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-"));
    const ref = join(dir, "src.png"); await writeFile(ref, PNG);
    const { calls, deps } = fakeServer("completed");
    const out = join(dir, "out.png");
    await runQwenEditJob({ prompt: "make the tail blue", refs: [ref], width: 512, height: 512, steps: 20, seed: 3, cfg: 2.5 }, out, undefined, deps);
    expect(calls[0].body).toMatchObject({ prompt: "make the tail blue", width: 512, height: 512, seed: 3, output_format: "png", sample_params: { sample_steps: 20, guidance: { txt_cfg: 2.5 } } });
    expect((calls[0].body!.ref_images as string[])[0]).toBe(PNG.toString("base64"));
    expect((await readFile(out)).equals(PNG)).toBe(true);
  });

  it("surfaces sd-server failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-"));
    const ref = join(dir, "src.png"); await writeFile(ref, PNG);
    const { deps } = fakeServer("failed");
    await expect(runQwenEditJob({ prompt: "x", refs: [ref], width: 512, height: 512, steps: 20, seed: 0, cfg: 2.5 }, join(dir, "o.png"), undefined, deps)).rejects.toThrow(/failed.*out of memory/);
  });

  it("refuses to run without a source image or when disabled", async () => {
    const context = { outputDirectory: await mkdtemp(join(tmpdir(), "qwen-")) };
    const run = (enabled: boolean, images: unknown[]) => createQwenEditNodeRunner({ enabled })({ node: { id: "n", type: "ai.image.generate" }, params: { prompt: "x", images }, inputs: {}, context } as never);
    await expect(run(false, [])).rejects.toThrow(/not enabled/);
    await expect(run(true, [])).rejects.toThrow(/at least one source image/);
  });
});
