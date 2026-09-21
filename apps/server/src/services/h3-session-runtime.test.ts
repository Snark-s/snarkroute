import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  h3VastConfigStatus,
  generationInputForH3QueueItem,
  idempotencyKeyForQueueItem,
  inferenceStepsForWorker,
  promptForH3QueueItem,
} from "./h3-session-runtime";

const directories: string[] = [];

describe("H3 operation reference roles", () => {
  it("instructs style transfer to use image appearance and video motion", () => {
    const prompt = promptForH3QueueItem({ operation: "style_transfer", prompt: "лошадь скачет. Стиль — аниме" });
    expect(prompt).toContain("<Picture 1>");
    expect(prompt).toContain("<Video 1>");
    expect(prompt).toContain("<Subject 1>");
    expect(prompt).toContain("attribute_transfer");
    expect(prompt).toContain("weak_reference");
    expect(prompt).toContain("Redraw every frame");
    expect(prompt).toContain("polished colorful anime artwork");
    expect(prompt).toContain("лошадь скачет. Стиль — аниме");
  });
  it("preserves free-form reference prompts", () => {
    expect(promptForH3QueueItem({ operation: "reference_mix", prompt: "Custom prompt" })).toBe("Custom prompt");
  });
  it("uses the operation-aware prompt in the worker request", () => {
    const input = generationInputForH3QueueItem({
      operation: "style_transfer",
      prompt: "anime ink",
      duration: 5,
      aspectRatio: "16:9",
      variants: 1,
      renderMode: "preview",
    }, [
      { kind: "video", uri: "file:///tmp/motion.mp4", role: "reference", visualMode: "motion" },
      { kind: "image", uri: "file:///tmp/style.png", role: "reference" },
    ], 4);

    expect(input.prompt).toContain("[video editing + visual style transfer]");
    expect(input.prompt).toContain("<Subject 1>");
    expect(input.prompt).toContain("anime ink");
    expect(input.inferenceSteps).toBe(4);
    expect(input.references?.[0]).toMatchObject({ kind: "video", visualMode: "motion" });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("H3 managed Vast configuration", () => {
  it("is ready for the SSH-tunnel mode without a public worker URL", () => {
    const directory = mkdtempSync(join(tmpdir(), "h3-vast-config-"));
    directories.push(directory);
    const key = join(directory, "id_ed25519");
    writeFileSync(key, "test key");
    vi.stubEnv("VAST_API_KEY", "vast-key");
    vi.stubEnv("HF_TOKEN", "hf-test-token");
    vi.stubEnv("H3_WORKER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("H3_ACCEPT_MODEL_LICENSE", "1");
    vi.stubEnv("H3_VAST_TEMPLATE_HASH", "template-hash");
    vi.stubEnv("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
    vi.stubEnv("H3_VAST_SSH_PRIVATE_KEY", key);
    vi.stubEnv("H3_VAST_WORKER_URL_TEMPLATE", "");

    const status = h3VastConfigStatus();
    expect(status).toMatchObject({ configured: true, connectionMode: "ssh_tunnel", sshKeyConfigured: true, workerUrlTemplateConfigured: false });
  });

  it("fails closed when the configured private key is missing", () => {
    vi.stubEnv("VAST_API_KEY", "vast-key");
    vi.stubEnv("HF_TOKEN", "hf-test-token");
    vi.stubEnv("H3_WORKER_SERVICE_TOKEN", "service-token");
    vi.stubEnv("H3_ACCEPT_MODEL_LICENSE", "1");
    vi.stubEnv("H3_VAST_TEMPLATE_HASH", "template-hash");
    vi.stubEnv("H3_VAST_CONNECTION_MODE", "ssh_tunnel");
    vi.stubEnv("H3_VAST_SSH_PRIVATE_KEY", join(tmpdir(), "missing-h3-private-key"));

    expect(h3VastConfigStatus()).toMatchObject({ configured: false, sshKeyConfigured: false });
  });
});

describe("H3 backend profiles", () => {
  it("uses the documented four-step preview default only for matlow_int8", () => {
    expect(inferenceStepsForWorker({ renderMode: "preview" }, "matlow_int8")).toBe(4);
    expect(inferenceStepsForWorker({ renderMode: "preview" }, "sglang")).toBeUndefined();
    expect(inferenceStepsForWorker({ renderMode: "final" }, "matlow_int8")).toBeUndefined();
    expect(
      inferenceStepsForWorker({ renderMode: "preview", inferenceSteps: 6 }, "matlow_int8")
    ).toBe(6);
  });
});

describe("H3 queue idempotency", () => {
  const item = {
    id: "h3q_example",
    operation: "first_last_frame" as const,
    prompt: "A girl wakes up",
    duration: 10,
    aspectRatio: "16:9",
    seed: 134897941,
    variants: 1,
    renderMode: "final" as const,
    startedAt: "2026-09-10T08:00:00.000Z",
    assets: [
      {
        slot: "firstFrame" as const,
        kind: "image" as const,
        path: "C:/inputs/image.png",
        filename: "image.png",
        mimeType: "image/png",
      },
    ],
  };

  it("keeps the same key within one render attempt", () => {
    expect(idempotencyKeyForQueueItem(item)).toBe(idempotencyKeyForQueueItem({ ...item }));
  });

  it("uses a new key for an explicit retry with freshly uploaded asset URIs", () => {
    const before = idempotencyKeyForQueueItem(item);
    const after = idempotencyKeyForQueueItem({ ...item, startedAt: "2026-09-10T08:01:00.000Z" });

    expect(after).not.toBe(before);
    expect(after).toMatch(/^h3q_example:[a-f0-9]{32}$/);
  });

  it("uses a new key when an edited field changes the worker request", () => {
    const before = idempotencyKeyForQueueItem(item);
    const after = idempotencyKeyForQueueItem({ ...item, renderMode: "preview" });

    expect(after).not.toBe(before);
    expect(after).toMatch(/^h3q_example:[a-f0-9]{32}$/);
  });
});
