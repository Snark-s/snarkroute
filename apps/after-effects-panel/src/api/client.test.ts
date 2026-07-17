import { describe, expect, it, vi } from "vitest";
import { providerNeutralJobRequest, SnarkRouteGatewayClient } from "./client";
import type { VideoModel } from "../types";
describe("gateway client", () => {
  it("returns exact health diagnostics for HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("provider unavailable", { status: 503, statusText: "Unavailable" })) as unknown as typeof fetch;
    const client = new SnarkRouteGatewayClient("http://127.0.0.1:4317", fetchImpl);
    await expect(client.health()).resolves.toMatchObject({ connected: false, url: "http://127.0.0.1:4317/health", status: 503, responseBody: "provider unavailable", error: "HTTP 503 Unavailable" });
  });

  it("invokes browser fetch with the Window/global receiver", async () => {
    const receiverCheckingFetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    } as typeof fetch;
    const client = new SnarkRouteGatewayClient("http://127.0.0.1:4317", receiverCheckingFetch);
    await expect(client.health()).resolves.toMatchObject({ connected: true, status: 200 });
  });

  it("puts the uploaded asset id and path in the provider-neutral image input", () => {
    const model = { nodeType: "polza.video.generate", storedModelId: "stored-wan", providerModelId: "wan/2.6", provider: "polza" } as VideoModel;
    expect(providerNeutralJobRequest({ model, prompt: "move", parameters: {}, asset: { id: "asset_frame", path: "C:\\assets\\frame.png" } })).toMatchObject({
      modelId: "stored-wan",
      providerModelId: "wan/2.6",
      inputs: [{ kind: "image", assetId: "asset_frame", path: "C:\\assets\\frame.png" }]
    });
  });

  it("preserves schema-derived required params in the gateway request", () => {
    const model = { nodeType: "polza.video.generate", storedModelId: "kling/v2.6", providerModelId: "kling/v2.6", provider: "polza" } as VideoModel;
    expect(providerNeutralJobRequest({ model, prompt: "move", parameters: { aspect_ratio: "16:9", sound: "false" }, asset: { id: "asset_frame", path: "C:\\assets\\frame.png" } })).toMatchObject({
      parameters: { aspect_ratio: "16:9", sound: "false" }
    });
  });
});
