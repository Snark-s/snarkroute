import { describe, expect, it, vi } from "vitest";
import { createReplicateClient } from "../src/index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

describe("Replicate client", () => {
  it("creates a prediction", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "p1", status: "starting" }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    await expect(client.createPrediction("owner/model", { prompt: "hi" })).resolves.toMatchObject({ id: "p1" });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/predictions"), expect.objectContaining({ method: "POST" }));
  });

  it("polls until a prediction succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "processing" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "succeeded", output: ["ok"], urls: { web: "https://replicate.com/p/p1" } }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    const result = await client.runPrediction("owner/model", { prompt: "hi" }, { pollingIntervalMs: 1 });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual(["ok"]);
  });

  it("returns failed prediction details", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "processing" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p1", status: "failed", error: "bad input" }));
    const client = createReplicateClient({ token: "token", fetchImpl });
    const result = await client.runPrediction("owner/model", {}, { pollingIntervalMs: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("bad input");
  });

  it("fails clearly without a token", async () => {
    const client = createReplicateClient({ token: "" });
    await expect(client.createPrediction("owner/model", {})).rejects.toThrow(/REPLICATE_API_TOKEN/);
  });
});
