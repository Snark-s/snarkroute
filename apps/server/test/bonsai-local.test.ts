import { describe, expect, it, vi } from "vitest";
import { readBonsaiStatus } from "../src/services/bonsai-local";

const config = {
  baseUrl: "http://127.0.0.1:8080/v1",
  demoPath: "I:\\AI\\Bonsai-demo",
  modelId: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
  port: 8080
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

  it("does not claim an unrelated service on port 8080", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "another-model" }] }), { status: 200 }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "error",
      model_loaded: false,
      error: expect.stringContaining("another service")
    });
  });

  it("reports loading while llama-server owns the port but has not exposed models yet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Loading model", { status: 503 }));
    await expect(readBonsaiStatus({ config, fetchImpl, portListening: async () => true })).resolves.toMatchObject({
      status: "loading",
      model_loaded: false
    });
  });
});
