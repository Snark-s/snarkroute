import { describe, expect, it, vi } from "vitest";
import { createH3RegenerationClient, createH3WorkerClient, estimateH3Regeneration, serializeH3Request } from "../src/index";

describe("MiniMax H3 adapter", () => {
  it("serializes text, first/last frame, and reference modes to the official SGLang contract", () => {
    expect(serializeH3Request({ prompt: "scene", duration: 5 })).toMatchObject({ task: "t2va", target: { short_edge: 768, duration_seconds: 5 }, conditions: [] });
    expect(serializeH3Request({ prompt: "scene", duration: 8, references: [{ kind: "image", uri: "file:///data/first.png", role: "firstFrame" }, { kind: "image", uri: "file:///data/last.png", role: "lastFrame" }] }).conditions).toEqual([{ type: "image", uri: "file:///data/first.png", role: "keyframe", frame_index: 0 }, { type: "image", uri: "file:///data/last.png", role: "keyframe", frame_index: -1 }]);
    expect(serializeH3Request({ prompt: "scene", duration: 6, references: [{ kind: "image", uri: "https://assets/ref.png" }, { kind: "audio", uri: "https://assets/ref.wav" }] })).toMatchObject({ task: "ref2va", conditions: [{ type: "image", role: "reference" }, { type: "audio", role: "reference" }] });
    expect(serializeH3Request({ prompt: "transfer motion", duration: 6, references: [{ kind: "video", uri: "https://assets/motion.mp4", role: "reference" }, { kind: "image", uri: "https://assets/first.png", role: "reference" }] })).toMatchObject({ task: "ref2va", conditions: [{ type: "video", uri: "https://assets/motion.mp4", role: "reference" }, { type: "image", uri: "https://assets/first.png", role: "reference" }] });
  });
  it("enforces H3 duration and reference limits", () => { expect(() => serializeH3Request({ prompt: "x", duration: 3 })).toThrow("between 4 and 15"); expect(() => serializeH3Request({ prompt: "x", duration: 5, references: [{ kind: "audio", uri: "https://assets/a.wav" }] })).toThrow("require at least one image or video"); });
  it("keeps the service token only in the Authorization header", async () => { const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "h3_1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch; const client = createH3WorkerClient({ baseUrl: "https://worker", serviceToken: "top-secret", fetchImpl }); await client.create({ prompt: "scene", duration: 5 }); expect(String(fetchImpl.mock.calls[0][1]?.body)).not.toContain("top-secret"); expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer top-secret" }); });
  it("estimates 2K regeneration from configurable per-second pricing and markup", () => { expect(estimateH3Regeneration(10, { rateUsdPerSecond: 0.05, markupPercent: 10, markupCredits: 2 })).toMatchObject({ providerUsd: 0.5, baseCredits: 50, markupCredits: 7, finalCredits: 57 }); });
  it("serializes the official 2K regeneration request without exposing the API key", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task_id: "regen_1" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createH3RegenerationClient({ baseUrl: "https://api.minimax.io", apiKey: "backend-only-secret", fetchImpl });
    await client.create({ prompt: "original context", baseVideo: new Uint8Array([1, 2, 3]), idempotencyKey: "job:variant:2k" });
    const init = fetchImpl.mock.calls[0][1], body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "MiniMax-H3", resolution: "2K", content: [{ type: "text", text: "original context" }, { type: "video_url", role: "base_video" }] });
    expect(body.content[1].video_url.url).toBe("data:video/mp4;base64,AQID");
    expect(String(init?.body)).not.toContain("backend-only-secret");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer backend-only-secret", "Idempotency-Key": "job:variant:2k" });
  });
});
