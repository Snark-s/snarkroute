import { describe, expect, it, vi } from "vitest";
import { cameraPathForH3Max, compileCameraPathPrompt, createH3HostedClient, createH3RegenerationClient, createH3WorkerClient, estimateH3HostedCost, estimateH3Regeneration, H3_CAMERA_PRESETS, isCameraLoopClosed, normalizeH3HostedError, sampleCameraPath, serializeH3HostedRequest, serializeH3Request } from "../src/index";

describe("MiniMax H3 adapter", () => {
  it("serializes text, first/last frame, and reference modes to the official SGLang contract", () => {
    expect(serializeH3Request({ prompt: "scene", duration: 5 })).toMatchObject({ task: "t2va", target: { short_edge: 768, duration_seconds: 5 }, conditions: [] });
    expect(serializeH3Request({ prompt: "scene", duration: 8, references: [{ kind: "image", uri: "file:///data/first.png", role: "firstFrame" }, { kind: "image", uri: "file:///data/last.png", role: "lastFrame" }] }).conditions).toEqual([{ type: "image", uri: "file:///data/first.png", role: "keyframe", frame_index: 0 }, { type: "image", uri: "file:///data/last.png", role: "keyframe", frame_index: -1 }]);
    expect(serializeH3Request({ prompt: "scene", duration: 6, references: [{ kind: "image", uri: "https://assets/ref.png" }, { kind: "audio", uri: "https://assets/ref.wav" }] })).toMatchObject({ task: "ref2va", conditions: [{ type: "image", role: "reference" }, { type: "audio", role: "reference" }] });
    expect(serializeH3Request({ prompt: "transfer motion", duration: 6, references: [{ kind: "video", uri: "https://assets/motion.mp4", role: "reference" }, { kind: "image", uri: "https://assets/first.png", role: "reference" }] })).toMatchObject({ task: "ref2va", conditions: [{ type: "video", uri: "https://assets/motion.mp4", role: "reference" }, { type: "image", uri: "https://assets/first.png", role: "reference" }] });
    expect(serializeH3Request({ prompt: "restyle", duration: 6, references: [{ kind: "video", uri: "https://assets/motion.mp4", role: "reference", visualMode: "motion" }, { kind: "image", uri: "https://assets/style.png", role: "reference" }] })).toMatchObject({ task: "ref2va", conditions: [{ type: "video", visual_mode: "motion" }, { type: "image" }] });
  });
  it("enforces H3 duration and reference limits", () => { expect(() => serializeH3Request({ prompt: "x", duration: 3 })).toThrow("between 4 and 15"); expect(() => serializeH3Request({ prompt: "x", duration: 5, references: [{ kind: "audio", uri: "https://assets/a.wav" }] })).toThrow("require at least one image or video"); });
  it("normalizes imported adaptive ratios for the local worker contract", () => {
    expect(serializeH3Request({ prompt: "scene", duration: 5, aspectRatio: "adaptive" }).target.aspect_ratio).toBe("auto");
  });
  it("passes the per-render attention mode to the local worker", () => {
    expect(serializeH3Request({ prompt: "scene", duration: 5, attentionMode: "veda" })).toHaveProperty("attention_mode", "veda");
    expect(serializeH3Request({ prompt: "scene", duration: 5, attentionMode: "dense" })).toHaveProperty("attention_mode", "dense");
    expect(serializeH3Request({ prompt: "scene", duration: 5 })).not.toHaveProperty("attention_mode");
  });
  it("omits the default base model field for legacy workers but keeps explicit 10eros variants", () => {
    expect(serializeH3Request({ prompt: "scene", duration: 5, modelVariant: "h3_base" })).not.toHaveProperty("model_variant");
    expect(serializeH3Request({ prompt: "scene", duration: 5, modelVariant: "10eros_max_turbo" })).toHaveProperty("model_variant", "10eros_max_turbo");
  });
  it("applies FaceSwap only as an explicit base Ref2VA identity modifier", () => {
    const request = serializeH3Request({ prompt: "keep the performance", duration: 5, modelVariant: "h3_base", references: [{ kind: "video", uri: "https://assets/performance.mp4" }, { kind: "image", uri: "https://assets/person.png", purpose: "identity" }], identityTransfer: { enabled: true, strength: 0.8 } });
    expect(request).toMatchObject({ task: "ref2va", prompt: "Faceswap, keep the performance", identity_transfer: { enabled: true, strength: 0.8 } });
    expect(() => serializeH3Request({ ...requestToInput(), modelVariant: "10eros_max", identityTransfer: { enabled: true } })).toThrow("requires h3_base");
  });
  it("applies Authentic Cinematic Texture only as an explicit H3 Base visual modifier", () => {
    const withoutTrigger = serializeH3Request({ prompt: "natural window light", duration: 5, modelVariant: "h3_base", visualModifier: { id: "authentic_cinematic_texture", enabled: true, strength: 0.7 } });
    expect(withoutTrigger.visual_modifier).toEqual({ id: "authentic_cinematic_texture", enabled: true, strength: 0.7, include_trigger: false });
    expect(withoutTrigger.prompt).toBe("natural window light");
    const withTrigger = serializeH3Request({ prompt: "natural window light", duration: 5, modelVariant: "h3_base", visualModifier: { id: "authentic_cinematic_texture", enabled: true, strength: 0.5, includeTrigger: true } });
    expect(withTrigger.prompt).toBe("DY, natural window light");
    expect(() => serializeH3Request({ ...requestToInput(), modelVariant: "10eros_max_turbo", visualModifier: { id: "authentic_cinematic_texture", enabled: true } })).toThrow("requires h3_base");
    expect(() => serializeH3Request({ ...requestToInput(), identityTransfer: { enabled: true }, visualModifier: { id: "authentic_cinematic_texture", enabled: true }, references: [{ kind: "video", uri: "https://assets/performance.mp4" }, { kind: "image", uri: "https://assets/person.png", purpose: "identity" }] })).toThrow("cannot be combined");
  });
  it("normalizes CameraPath without angle jumps and supports monotone interpolation and loop closure", () => {
    const path = { schemaVersion: "1.0" as const, interpolation: "smooth" as const, loopClosure: "auto" as const, keyframes: [{ time: 0, azimuth: 350, elevation: 0, distance: 1 }, { time: 0.5, azimuth: 10, elevation: 20, distance: 0.8 }, { time: 1, azimuth: 350, elevation: 0, distance: 1 }] };
    expect(cameraPathForH3Max(path).camera_trajectory.map((pose) => pose.azimuth)).toEqual([350, 370, 350]);
    const sample = sampleCameraPath(path, 0.25);
    expect(sample.azimuth).toBeGreaterThanOrEqual(350);
    expect(sample.azimuth).toBeLessThanOrEqual(370);
    expect(isCameraLoopClosed(path)).toBe(true);
    expect(compileCameraPathPrompt(H3_CAMERA_PRESETS.dollyIn())).toContain("dolly in");
    expect(cameraPathForH3Max({ ...H3_CAMERA_PRESETS.orbitRight(), startHold: 0.1, endHold: 0.2 }).camera_trajectory.map((pose) => pose.time)).toEqual([0.1, 0.8]);
    expect(() => cameraPathForH3Max({ ...H3_CAMERA_PRESETS.orbitRight(), subjectBox: { x: 0.8, y: 0.1, width: 0.3, height: 0.4 } })).toThrow("contained by the frame");
  });
  it("routes H3 Max requests to capability-specific fal endpoints", () => {
    expect(serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max_turbo" }).endpoint).toBe("minimax/h3-max-turbo/text-to-video");
    expect(serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max", references: [{ kind: "image", role: "reference", uri: "https://assets/subject.png" }] }).endpoint).toBe("minimax/h3-max/reference-to-video");
    const camera = serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max", references: [{ kind: "image", role: "firstFrame", uri: "https://assets/start.png" }], cameraPath: H3_CAMERA_PRESETS.orbit360() });
    expect(camera).toMatchObject({ endpoint: "minimax/h3-max/camera-controls", provenance: { owner: "fal", nativeCameraAdapter: true } });
    expect(camera.body.camera_trajectory).toEqual([{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 1, azimuth: 360, elevation: 0, distance: 1 }]);
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max_turbo", references: [{ kind: "video", uri: "https://assets/ref.mp4" }] })).toThrow("no reference-to-video endpoint");
  });
  it("maps first and last frames without treating them as semantic references", () => {
    const request = serializeH3HostedRequest({ prompt: "arrive at the final pose", duration: 5, modelVariant: "h3_max", references: [{ kind: "image", role: "firstFrame", uri: "https://assets/start.png" }, { kind: "image", role: "lastFrame", uri: "https://assets/end.png" }] });
    expect(request).toMatchObject({ endpoint: "minimax/h3-max/image-to-video", body: { image_url: "https://assets/start.png", end_image_url: "https://assets/end.png", resolution: "768P" } });
    expect(request.body).not.toHaveProperty("reference_image_urls");
    const turbo = serializeH3HostedRequest({ prompt: "arrive at the final pose", duration: 5, modelVariant: "h3_max_turbo", resolution: "768P", references: [{ kind: "image", role: "firstFrame", uri: "https://assets/start.png" }, { kind: "image", role: "lastFrame", uri: "https://assets/end.png" }] });
    expect(turbo).toMatchObject({ endpoint: "minimax/h3-max-turbo/image-to-video", body: { image_url: "https://assets/start.png", end_image_url: "https://assets/end.png", resolution: "768P" } });
  });
  it("rejects unsupported hosted fields before spending provider credits", () => {
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max_turbo", visualModifier: { id: "authentic_cinematic_texture", enabled: true } })).toThrow("require local h3_base");
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 4, modelVariant: "h3_max" })).toThrow("between 5 and 15");
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max", identityTransfer: { enabled: true } })).toThrow("not available on hosted H3 Max");
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max", references: [{ kind: "image", role: "firstFrame", uri: "https://assets/start.png" }, { kind: "image", role: "reference", uri: "https://assets/subject.png" }] })).toThrow("different endpoints");
    expect(() => serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max", references: Array.from({ length: 13 }, (_, index) => ({ kind: "image" as const, role: "reference" as const, uri: `https://assets/${index}.png` })) })).toThrow("12 reference files total");
  });
  it("normalizes hosted provider failures into stable error categories", () => {
    expect(normalizeH3HostedError(401, '{"detail":"Invalid API key"}')).toMatchObject({ code: "auth", retryable: false });
    expect(normalizeH3HostedError(402, '{"detail":"Insufficient credits"}')).toMatchObject({ code: "insufficient_credits", retryable: false });
    expect(normalizeH3HostedError(403, '{"detail":"User is locked. Reason: Exhausted balance."}')).toMatchObject({ code: "insufficient_credits", retryable: false });
    expect(normalizeH3HostedError(429, "Rate limit exceeded")).toMatchObject({ code: "rate_limit", retryable: true });
    expect(normalizeH3HostedError(422, '{"detail":"Unsupported resolution"}')).toMatchObject({ code: "unsupported_parameter" });
    expect(normalizeH3HostedError(undefined, "Generation failed on GPU")).toMatchObject({ code: "generation_failed", retryable: true });
  });
  it("estimates the current fal output rate separately from reference token charges", () => {
    expect(estimateH3HostedCost({ variant: "h3_max", duration: 5, resolution: "768P", now: new Date("2026-09-27T12:00:00Z") })).toMatchObject({ amountUsd: 0.4, rateUsdPerSecond: 0.08, excludesReferenceTokenCharges: true });
    expect(estimateH3HostedCost({ variant: "h3_max_turbo", duration: 5, resolution: "768P", now: new Date("2026-09-27T12:00:00Z") })).toMatchObject({ amountUsd: 0.2, rateUsdPerSecond: 0.04, excludesReferenceTokenCharges: true });
    expect(estimateH3HostedCost({ variant: "h3_max", duration: 5, resolution: "768P", endpoint: "minimax/h3-max/reference-to-video", now: new Date("2026-09-27T12:00:00Z") })).toMatchObject({ amountUsd: 0.4, rateUsdPerSecond: 0.08, promotion: null });
    expect(estimateH3HostedCost({ variant: "h3_max", duration: 5, resolution: "768P", now: new Date("2026-10-02T12:00:00Z") })).toMatchObject({ amountUsd: 0.4, rateUsdPerSecond: 0.08 });
  });
  it("keeps FAL_KEY in the queue Authorization header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ request_id: "fal_1" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createH3HostedClient({ apiKey: "fal-secret", fetchImpl });
    await client.submit(serializeH3HostedRequest({ prompt: "scene", duration: 5, modelVariant: "h3_max_turbo" }));
    expect(String(fetchImpl.mock.calls[0][1]?.body)).not.toContain("fal-secret");
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Key fal-secret" });
  });
  it("polls the fal queue root returned for H3 Max operation endpoints", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createH3HostedClient({ apiKey: "fal-secret", fetchImpl });
    await client.status("minimax/h3-max/image-to-video", "req_1");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://queue.fal.run/minimax/h3-max/requests/req_1/status");
  });
  it("keeps the service token only in the Authorization header", async () => { const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "h3_1", status: "queued" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch; const client = createH3WorkerClient({ baseUrl: "https://worker", serviceToken: "top-secret", fetchImpl }); await client.create({ prompt: "scene", duration: 5 }); expect(String(fetchImpl.mock.calls[0][1]?.body)).not.toContain("top-secret"); expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer top-secret" }); });
  it("encodes Unicode asset filenames into an HTTP-safe header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "asset_1", uri: "file:///inputs/asset_1/input.png", mimeType: "image/png" }), { status: 201, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createH3WorkerClient({ baseUrl: "https://worker", serviceToken: "secret", fetchImpl });
    await client.upload(new Uint8Array([137, 80, 78, 71]), "Снимок экрана.png", "image/png");
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ "X-Filename": encodeURIComponent("Снимок экрана.png") });
  });
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

function requestToInput() { return { prompt: "identity", duration: 5, references: [{ kind: "video" as const, uri: "https://assets/performance.mp4" }, { kind: "image" as const, uri: "https://assets/person.png", purpose: "identity" as const }] }; }
