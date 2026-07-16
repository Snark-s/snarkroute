import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health", () => {
  it("is registered on the main server and allows the local CEP origin", async () => {
    app = buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "file://" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "snarkroute-server" });
    expect(response.headers["access-control-allow-origin"]).toBe("file://");

    const opaqueOriginResponse = await app.inject({ method: "GET", url: "/health", headers: { origin: "null" } });
    expect(opaqueOriginResponse.statusCode).toBe(200);
    expect(opaqueOriginResponse.headers["access-control-allow-origin"]).toBe("null");
  });
});
