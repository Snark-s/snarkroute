import { describe, expect, it, vi } from "vitest";
import { inspectH3Connection, normalizeH3WorkerUrl } from "./h3-connection";

describe("H3 connection inspection", () => {
  it("returns a sanitized ready status and capabilities", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, backend: "sglang", backendVersion: "0.5.19", reason: null, activeJobs: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ backend: "sglang", capabilities: [{ name: "fl2va", available: true }, { name: "video_inpaint", available: false, experimental: true }] }), { status: 200 }));

    const result = await inspectH3Connection({ workerUrl: "https://gpu.example.test/", serviceToken: "secret-token", fetchImpl });

    expect(result).toMatchObject({ configured: true, connected: true, ready: true, workerUrl: "https://gpu.example.test", backend: "sglang", activeJobs: 1 });
    expect(result.capabilities).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(fetchImpl).toHaveBeenCalledWith("https://gpu.example.test/ready", expect.objectContaining({ headers: { Authorization: "Bearer secret-token" } }));
  });

  it("distinguishes an invalid token without exposing it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const result = await inspectH3Connection({ workerUrl: "http://127.0.0.1:8000", serviceToken: "wrong-secret", fetchImpl });
    expect(result).toMatchObject({ configured: true, connected: false, ready: false, error: "H3 worker rejected the service token." });
    expect(JSON.stringify(result)).not.toContain("wrong-secret");
  });

  it("validates worker URLs", () => {
    expect(normalizeH3WorkerUrl("https://gpu.example.test/")).toBe("https://gpu.example.test");
    expect(normalizeH3WorkerUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(() => normalizeH3WorkerUrl("file:///tmp/worker")).toThrow(/http/);
    expect(() => normalizeH3WorkerUrl("http://gpu.example.test:8000")).toThrow(/must use HTTPS/);
    expect(() => normalizeH3WorkerUrl("https://user:pass@gpu.example.test")).toThrow(/without credentials/);
  });

  it("reports an invalid configured URL without throwing or exposing the token", async () => {
    const result = await inspectH3Connection({ workerUrl: "file:///tmp/worker", serviceToken: "secret-token" });
    expect(result).toMatchObject({ configured: true, connected: false, ready: false, workerUrl: "", error: expect.stringMatching(/http/) });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});
