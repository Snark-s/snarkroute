import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKieTaskInput, createKieNodeRunner, createKieProviderAdapter, estimateKiePricingQuote, kieResultUrls, KIE_PROVIDER_MANIFEST, KieError, listDocumentedKieModels } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("KIE adapter", () => {
  it("publishes only capabilities and constraints verified in the documented manifest", () => {
    const kling = listDocumentedKieModels().find((model) => model.id === "kling-3.0/video");
    expect(kling).toMatchObject({ canonicalModelId: "kling-3.0-pro", capabilities: ["video.generate"], constraints: { mode: "pro", firstLastFrame: true, audio: true } });
    expect(KIE_PROVIDER_MANIFEST).toMatchObject({ id: "kie", apiKeyEnv: "KIE_API_KEY", modelDiscovery: "official_documentation_curated" });
    expect(listDocumentedKieModels().find((model) => model.id === "gpt-5-2")).toMatchObject({ canonicalModelId: "gpt-5.2", capabilities: ["text.generate"], constraints: { chatEndpoint: "/gpt-5-2/v1/chat/completions" } });
  });

  it("builds model-specific inputs without exposing internal routing parameters", () => {
    expect(buildKieTaskInput("kling-3.0/video", { prompt: "move" }, { executionProvider: "kie", providerModelId: "kling-3.0/video", duration: 5, sound: true, unsupported: "never-send" }, { images: ["first.png", "last.png"], videos: ["unused.mp4"], audios: ["unused.mp3"] })).toEqual({ prompt: "move", duration: "5", sound: true, image_urls: ["first.png", "last.png"], mode: "pro", multi_shots: false });
    expect(buildKieTaskInput("nano-banana-pro", { prompt: "edit" }, { resolution: "4K" }, { images: ["ref.png"], videos: [], audios: [] })).toMatchObject({ image_input: ["ref.png"], resolution: "4K" });
    expect(buildKieTaskInput("bytedance/seedance-2", { prompt: "move" }, { image_mode: "first_last", duration: "15", generate_audio: true }, { images: ["first.png", "last.png"], videos: ["reference.mp4"], audios: ["reference.mp3"] })).toMatchObject({ first_frame_url: "first.png", last_frame_url: "last.png", reference_video_urls: ["reference.mp4"], reference_audio_urls: ["reference.mp3"], duration: 15, generate_audio: true });
    expect(buildKieTaskInput("wan/2-6-image-to-video", { prompt: "move" }, { duration: 10, sound: true, aspectRatio: "16:9" }, { images: ["frame.png"], videos: [], audios: [] })).toEqual({ prompt: "move", duration: "10", image_urls: ["frame.png"] });
  });

  it("removes canvas image references from Kling first/last-frame prompts", () => {
    expect(buildKieTaskInput(
      "kling-3.0/video",
      { prompt: "From the dome @image 1 a ship emerges as if from a cocoon @image 2, then flies away." },
      { duration: 5 },
      { images: ["first.png", "last.png"], videos: [], audios: [] }
    )).toMatchObject({
      prompt: "From the dome a ship emerges as if from a cocoon, then flies away.",
      image_urls: ["first.png", "last.png"]
    });
  });

  it("submits, polls, retrieves and persists a KIE result through Model Gateway", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-kie-")); directories.push(directory);
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/api/v1/jobs/createTask")) return json({ code: 200, msg: "success", data: { taskId: "task_test" } });
      if (text.includes("/api/v1/jobs/recordInfo")) return json({ code: 200, msg: "success", data: { taskId: "task_test", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://result.example/image.png"] }), creditsConsumed: 12 } });
      if (text.endsWith("/api/v1/common/download-url")) return json({ code: 200, msg: "success", data: "https://download.example/image.png" });
      if (text === "https://download.example/image.png") return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`Unexpected URL ${text}`);
    });
    const runner = createKieNodeRunner("image.generate", { apiKey: "test-key", fetch: fetchMock as typeof fetch, outputDirectory: directory, pollIntervalMs: 1 });
    const result = await runner({ node: { id: "generate", type: "ai.image.generate", params: {} }, params: { model: "nano-banana-pro", prompt: "draw" }, inputs: {}, context: { runId: "run", route: {} as never, outputDirectory: directory, nodeOutputs: {}, log: () => undefined } });
    expect(result.output).toMatchObject({ provider: "kie", model: "nano-banana-pro", providerJobId: "task_test", image: { mimeType: "image/png" } });
    const path = (result.output as { image: { path: string } }).image.path;
    expect([...await readFile(path)]).toEqual([1, 2, 3]);
    expect(result.providerUsage).toMatchObject({ provider: "kie", status: "succeeded", metrics: { kieCreditsConsumed: 12 } });
    const downloadCall = fetchMock.mock.calls.find(([url]) => String(url) === "https://download.example/image.png");
    expect(downloadCall?.[1]).toBeUndefined();
  });

  it("normalizes provider failures and does not mark them successful", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => String(url).endsWith("createTask")
      ? json({ code: 200, data: { taskId: "task_failed" } })
      : json({ code: 200, data: { taskId: "task_failed", state: "fail", failCode: "content_policy", failMsg: "Rejected" } }));
    const adapter = createKieProviderAdapter({ apiKey: "test-key", fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const model = listDocumentedKieModels().find((entry) => entry.id === "flux-2/pro-text-to-image")!;
    await expect(adapter.invoke({ capability: "image.generate", model, input: { prompt: "draw" } })).rejects.toMatchObject<KieError>({ code: "content_policy", retryable: false });
  });

  it("runs the documented GPT-5.2 chat endpoint and captures token usage", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.kie.ai/gpt-5-2/v1/chat/completions");
      expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ role: "user", content: "hello" }], reasoning_effort: "high", tools: [{ type: "function", function: { name: "web_search" } }] });
      return json({ id: "chat_test", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    const runner = createKieNodeRunner("text.generate", { apiKey: "test-key", fetch: fetchMock as typeof fetch });
    const result = await runner({ node: { id: "text", type: "ai.text", params: {} }, params: { model: "gpt-5-2", prompt: "hello", reasoning_effort: "high", web_search: true, temperature: 2, max_tokens: 1 }, inputs: {}, context: { runId: "run", route: {} as never, outputDirectory: ".", nodeOutputs: {}, log: () => undefined } });
    expect(result.output).toMatchObject({ text: "hi", provider: "kie", model: "gpt-5-2", actualUsage: { total_tokens: 2 } });
    expect(result.providerUsage).toMatchObject({ provider: "kie", status: "succeeded", metrics: { total_tokens: 2 } });
  });

  it("keeps pricing on the provider route and parses result payload variants", () => {
    expect(estimateKiePricingQuote({ provider: "kie", providerModel: "nano-banana-pro", capability: "image.generate", params: { resolution: "4K" }, inputMetadata: {} })).toMatchObject({ estimatedCost: 0.12, currency: "USD", confidence: "exact" });
    expect(kieResultUrls(JSON.stringify({ resultUrls: ["a", "b"] }))).toEqual(["a", "b"]);
  });

  it("fails the node when a successful provider result cannot be persisted", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const text = String(url);
      if (text.endsWith("/api/v1/jobs/createTask")) return json({ code: 200, data: { taskId: "task_download" } });
      if (text.includes("/api/v1/jobs/recordInfo")) return json({ code: 200, data: { taskId: "task_download", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://result.example/image.png"] }) } });
      if (text.endsWith("/api/v1/common/download-url")) return json({ code: 200, data: "https://download.example/image.png" });
      if (text === "https://download.example/image.png") return new Response("missing", { status: 404 });
      throw new Error(`Unexpected URL ${text}`);
    });
    const runner = createKieNodeRunner("image.generate", { apiKey: "test-key", fetch: fetchMock as typeof fetch, outputDirectory: ".", pollIntervalMs: 1 });
    await expect(runner({ node: { id: "generate", type: "ai.image.generate", params: {} }, params: { model: "nano-banana-pro", prompt: "draw" }, inputs: {}, context: { runId: "run", route: {} as never, outputDirectory: ".", nodeOutputs: {}, log: () => undefined } }))
      .rejects.toMatchObject<KieError>({ code: "download_failed", retryable: true });
  });

  it("uploads local media, preserves remote media, and maps first/last/reference inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "snarkroute-kie-inputs-")); directories.push(directory);
    const image = join(directory, "last.png");
    const video = join(directory, "reference.mp4");
    const audio = join(directory, "reference.mp3");
    await Promise.all([writeFile(image, "image"), writeFile(video, "video"), writeFile(audio, "audio")]);
    let uploadIndex = 0;
    let submitted: Record<string, unknown> = {};
    const onProviderTaskCreated = vi.fn();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const text = String(url);
      if (text.endsWith("/api/file-stream-upload")) return json({ code: 200, data: { fileUrl: `https://uploaded.example/${++uploadIndex}` } });
      if (text.endsWith("/api/v1/jobs/createTask")) { submitted = JSON.parse(String(init?.body)); return json({ code: 200, data: { taskId: "task_inputs" } }); }
      if (text.includes("/api/v1/jobs/recordInfo")) return json({ code: 200, data: { taskId: "task_inputs", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://result.example/video.mp4"] }) } });
      throw new Error(`Unexpected URL ${text}`);
    });
    const adapter = createKieProviderAdapter({ apiKey: "test-key", fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const model = listDocumentedKieModels().find((entry) => entry.id === "bytedance/seedance-2")!;
    await adapter.invoke({ capability: "video.generate", model, input: { prompt: "move", images: [{ url: "https://remote.example/first.png" }, { path: image }], videos: [{ path: video }], audios: [{ path: audio }] }, parameters: { image_mode: "first_last" }, metadata: { onProviderTaskCreated } });
    expect(uploadIndex).toBe(3);
    expect(onProviderTaskCreated).toHaveBeenCalledWith("task_inputs");
    expect(submitted).toMatchObject({ model: "bytedance/seedance-2", input: { first_frame_url: "https://remote.example/first.png", last_frame_url: "https://uploaded.example/1", reference_video_urls: ["https://uploaded.example/2"], reference_audio_urls: ["https://uploaded.example/3"] } });
  });

  it("normalizes malformed task responses, timeouts, and local cancellation", async () => {
    const model = listDocumentedKieModels().find((entry) => entry.id === "flux-2/pro-text-to-image")!;
    const malformed = createKieProviderAdapter({ apiKey: "test-key", fetch: vi.fn(async () => json({ code: 200, data: {} })) as typeof fetch });
    await expect(malformed.invoke({ capability: "image.generate", model, input: { prompt: "draw" } })).rejects.toMatchObject<KieError>({ code: "invalid_response" });

    const waitingFetch = vi.fn(async (url: string | URL) => String(url).endsWith("createTask") ? json({ code: 200, data: { taskId: "task_wait" } }) : json({ code: 200, data: { taskId: "task_wait", state: "waiting" } }));
    const timed = createKieProviderAdapter({ apiKey: "test-key", fetch: waitingFetch as typeof fetch, pollIntervalMs: 2, timeoutMs: 1 });
    await expect(timed.invoke({ capability: "image.generate", model, input: { prompt: "draw" } })).rejects.toMatchObject<KieError>({ code: "timeout", retryable: true });

    const controller = new AbortController();
    controller.abort();
    const cancelled = createKieProviderAdapter({ apiKey: "test-key", fetch: waitingFetch as typeof fetch, pollIntervalMs: 1 });
    await expect(cancelled.invoke({ capability: "image.generate", model, input: { prompt: "draw" }, metadata: { signal: controller.signal } })).rejects.toMatchObject<KieError>({ code: "cancelled", retryable: false });
  });
});

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
