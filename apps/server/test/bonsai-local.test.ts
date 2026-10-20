import { describe, expect, it, vi } from "vitest";
import { readBonsaiStatus } from "../src/services/bonsai-local";

const config = {
  baseUrl: "http://127.0.0.1:8092/v1",
  demoPath: "I:\\AI\\Bonsai-demo",
  modelId: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
  port: 8092
};

describe("Bonsai local runtime status", () => {
  it("reports stopped when the configured port is free", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => false })).resolves.toMatchObject({
      service: "Bonsai 2 27B",
      status: "stopped",
      model_loaded: false
    });
  });

  it("reports ready only when the Bonsai model is exposed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "Ternary-Bonsai-2-27B-PQ2_0.gguf" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "ready",
      model_loaded: true,
      model_id: "Ternary-Bonsai-2-27B-PQ2_0.gguf"
    });
  });

  it("reports actual resident Bonsai size even if the configured start size differs", async () => {
    const config9b = { ...config, size: "9B" as const };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "Ternary-Bonsai-2-9B-PQ2_0.gguf" }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(readBonsaiStatus({ config: config9b, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      service: "Bonsai 2 9B", status: "ready", model_loaded: true,
      model_id: "Ternary-Bonsai-2-9B-PQ2_0.gguf"
    });
    const wrongModel = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: "Ternary-Bonsai-2-27B-PQ2_0.gguf" }]
    }), { status: 200 }));
    await expect(readBonsaiStatus({ config: config9b, fetchImpl: wrongModel, portListening: async () => true })).resolves.toMatchObject({
      service: "Bonsai 2 27B", status: "ready", model_loaded: true,
      model_id: "Ternary-Bonsai-2-27B-PQ2_0.gguf"
    });
  });

  it("does not claim an unrelated service on the inference port", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "another-model" }] }), { status: 200 }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "error",
      model_loaded: false,
      error: expect.stringContaining("another service")
    });
  });

  it("does not treat a foreign 503 service as a loading model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Loading model", { status: 503 }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "error",
      model_loaded: false
    });
  });

  it("rejects HTML or malformed JSON even when the port is occupied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>foreign server</html>", { status: 200 }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "error", model_loaded: false,
    });
  });
});
