import { describe, expect, it, vi } from "vitest";
import { createH3RegenerationClient, estimateH3Regeneration, serializeH3RegenerationRequest } from "../src/index";

const input = { prompt: "Original final prompt", baseVideo: new Uint8Array([1, 2, 3]) };

describe("official hosted regeneration", () => {
  it("forwards original first-frame conditioning in base_video mode", () => {
    const body = serializeH3RegenerationRequest({ ...input, references: [{ kind: "image", role: "first_frame", uri: "data:image/jpeg;base64,AQID" }] });
    expect(body).toEqual({ model: "MiniMax-H3", resolution: "2K", content: [
      { type: "text", text: input.prompt },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" }, role: "first_frame" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AQID" }, role: "base_video" }
    ] });
    expect(body).not.toHaveProperty("source_task_id");
  });

  it("rejects invalid reference role and private external sources before fetching", async () => {
    const fetchImpl = vi.fn();
    const client = createH3RegenerationClient({ apiKey: "fixture", fetchImpl });
    await expect(client.create({ ...input, references: [{ kind: "image", role: "base_video" as never, uri: "https://assets.example/frame.jpg" }] })).rejects.toThrow("reference role");
    await expect(client.create({ ...input, baseVideo: "https://127.0.0.1/source.mp4" })).rejects.toThrow("private host");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed inline references", () => {
    expect(() => serializeH3RegenerationRequest({ ...input, references: [{ kind: "image", role: "first_frame", uri: "data:video/mp4;base64,AQID" }] })).toThrow();
    expect(() => serializeH3RegenerationRequest({ ...input, references: [{ kind: "image", role: "first_frame", uri: "" }] })).toThrow();
  });

  it("checks the full encoded request size before a call", () => {
    expect(() => serializeH3RegenerationRequest(input, { maxRequestBytes: 100 })).toThrow("request body");
  });

  it("estimates the measured container duration without claiming actual billing", () => {
    expect(estimateH3Regeneration(5.184, { rateUsdPerSecond: 0.05, markupPercent: 0, markupCredits: 0 }).providerUsd).toBe(0.2592);
  });

  it.each([402, 400, 422, 429, 500])("does not retry a submission rejected with HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { type: status === 402 ? "insufficient_balance_error" : "bad_request_error", message: "provider rejected" } }), { status }));
    const client = createH3RegenerationClient({ apiKey: "fixture", fetchImpl });
    await expect(client.run(input)).rejects.toThrow(`(${status})`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls an accepted task without another create and ingests its output bytes", async () => {
    const fetchImpl = vi.fn(async (_url, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ task_id: "regeneration-1" }))
      : String(_url).includes("/v2/query/")
        ? new Response(JSON.stringify({ task: { id: "regeneration-1", status: "succeeded", content: { url: "https://cdn.example/output.mp4" } } }))
        : new Response(new Uint8Array([4, 5, 6])));
    const client = createH3RegenerationClient({ apiKey: "fixture", fetchImpl, pollingIntervalMs: 1 });
    const result = await client.run(input);
    expect(result).toEqual({ id: "regeneration-1", url: "https://cdn.example/output.mp4" });
    expect(new Uint8Array(await client.download(result.url))).toEqual(new Uint8Array([4, 5, 6]));
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not recreate a task that fails during polling", async () => {
    const fetchImpl = vi.fn(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { task_id: "rejected-1" } : { task: { status: "failed" } })));
    const client = createH3RegenerationClient({ apiKey: "fixture", fetchImpl, pollingIntervalMs: 1 });
    await expect(client.run(input)).rejects.toThrow("failed");
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
