import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health", () => {
  it("is registered on the main server for native loopback clients", async () => {
    app = buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, service: "snarkroute-server" }));
  });

  it("rejects file and opaque browser origins; the CEP panel uses native Node loopback transport", async () => {
    app = buildServer();
    for (const origin of ["file://", "null"]) {
      const response = await app.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "LOCAL_ORIGIN_REJECTED" });
    }
  });
});
