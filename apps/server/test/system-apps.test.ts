import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

// A port of its own for the Beamish checks, set before the routes module reads it (a real Imaginarium may run on 4870).
vi.hoisted(() => { process.env.IMAGINARIUM_PORT = "48707"; });

import { buildServer } from "../src/app";
import { systemAppCatalog } from "../src/routes/system";

describe("system app launcher", () => {
  it("describes every local product from one server-owned catalog", () => {
    expect(systemAppCatalog.map((app) => app.id)).toEqual([
      "living-canvas", "boojum", "brandeshmyg", "h3", "persona", "yue2", "beamish", "tove", "factory"
    ]);
    expect(systemAppCatalog.find((app) => app.id === "beamish")).toMatchObject({ name: "Бимиш", icon: "/beamish-icon.png", service: "imaginarium" });
    expect(systemAppCatalog.every((app) => app.url.startsWith("http://127.0.0.1:"))).toBe(true);
  });

  it("serves launcher cards without hardcoded model providers", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/api/system/apps" });
      const body = response.json();
      expect(response.statusCode).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.apps.map((entry: { id: string }) => entry.id)).toEqual(systemAppCatalog.map((entry) => entry.id));
      expect(JSON.stringify(body)).not.toMatch(/openrouter|polza|kie|google/i);
    } finally {
      await app.close();
    }
  });

  it("Beamish (Snark’s Imaginarium): state from its own health, stopped through its own shutdown", async () => {
    const port = systemAppCatalog.find((entry) => entry.id === "beamish")!.port;
    const calls: string[] = [];
    const fake = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, service: "snarks-imaginarium" }));
      if (req.method === "POST" && req.url === "/api/system/shutdown") {
        res.statusCode = 202;
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => { fake.close(); fake.closeAllConnections(); }, 50);
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const listening = await new Promise<boolean>((resolve) => { fake.once("error", () => resolve(false)); fake.listen(port, "127.0.0.1", () => resolve(true)); });
    expect(listening).toBe(true);
    const app = buildServer();
    try {
      const status = await app.inject({ method: "GET", url: "/api/system/apps/beamish/status" });
      expect(status.json()).toMatchObject({ ok: true, status: "ready", running: true });
      const listed = (await app.inject({ method: "GET", url: "/api/system/apps" })).json().apps.find((entry: { id: string }) => entry.id === "beamish");
      expect(listed).toMatchObject({ running: true, status: "ready" });
      const stop = await app.inject({ method: "POST", url: "/api/system/apps/beamish/stop", payload: {} });
      expect(stop.json()).toMatchObject({ ok: true, status: "stopped", running: false });
      expect(calls).toContain("POST /api/system/shutdown");
    } finally {
      fake.close();
      await app.close();
    }
  }, 30_000);
});
