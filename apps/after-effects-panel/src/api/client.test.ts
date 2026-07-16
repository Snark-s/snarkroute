import { describe, expect, it, vi } from "vitest";
import { SnarkRouteGatewayClient } from "./client";
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
});
