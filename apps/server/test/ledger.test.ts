import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("ledger API", () => {
  beforeEach(async () => {
    process.env.SNARKROUTE_NO_LISTEN = "1";
    const directory = join(tmpdir(), `sr-server-ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(directory, { recursive: true });
    const ledgerPath = join(directory, "runs.jsonl");
    process.env.SNARKROUTE_LEDGER_PATH = ledgerPath;
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        runId: "run-1",
        status: "succeeded",
        routeId: "route",
        routeTitle: "Route",
        providersUsed: [{ provider: "replicate", externalId: "prediction-1", token: "secret-token" }],
        estimatedProviderCost: null,
        actualProviderCost: null,
        paymentExecuted: false
      })}\n`,
      "utf8"
    );
  });

  afterEach(() => {
    delete process.env.SNARKROUTE_LEDGER_PATH;
    delete process.env.SNARKROUTE_NO_LISTEN;
  });

  it("returns runs without secrets", async () => {
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/ledger/runs" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("run-1");
    expect(response.body).not.toContain("secret-token");
  });

  it("returns a ledger summary", async () => {
    const { buildServer } = await import("../src/index");
    const app = buildServer();
    const response = await app.inject({ method: "GET", url: "/api/ledger/summary" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ totalRuns: 1, runsByProvider: { replicate: 1 }, paymentExecuted: false });
  });
});
