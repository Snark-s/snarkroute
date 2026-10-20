import { describe, expect, it, vi } from "vitest";
import { bonsaiSentinelTile, defaultSentinelTiles, Sentinel } from "./sentinel";

describe("SnarkRoute sentinel", () => {
  it("restarts a managed tile once and accepts a recovered health check", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const restart = vi.fn(async () => undefined);
    const sentinel = new Sentinel({ fetchImpl, portListening: async () => false });
    const result = await sentinel.checkTile({ id: "bonsai", label: "Bonsai", url: "http://127.0.0.1:18092", healthPath: "/v1/models", watch: "always", owner: "snarkroute", restart });
    expect(result).toMatchObject({ ok: true, restarted: true, status: "ok" });
    expect(restart).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not restart a foreign port and creates one stuck ticket after two failures", async () => {
    const tickets: unknown[] = [];
    const restart = vi.fn(async () => undefined);
    const now = new Date("2026-10-20T10:00:00.000Z");
    const sentinel = new Sentinel({
      fetchImpl: vi.fn(async () => new Response("foreign", { status: 404 })),
      now: () => now,
      portListening: async () => true,
      portOwner: async () => "foreign",
      ticketSink: ticket => { tickets.push(ticket); }
    });
    const tile = { id: "bonsai", label: "Bonsai", url: "http://127.0.0.1:18092", owner: "snarkroute" as const, restart };
    const first = await sentinel.checkTile(tile);
    const second = await sentinel.checkTile(tile);
    expect(first).toMatchObject({ ok: false, status: "degraded", portConflict: true, portOwner: "foreign" });
    expect(second).toMatchObject({ ok: false, status: "stuck", ticket: { reason: "port_conflict", status: "застрял" } });
    expect(restart).not.toHaveBeenCalled();
    expect(tickets).toHaveLength(1);
  });

  it("writes a pulse with the required agent fields", async () => {
    const pulses: unknown[] = [];
    const sentinel = new Sentinel({ fetchImpl: vi.fn(async () => new Response("ok", { status: 200 })), pulseSink: pulse => { pulses.push(pulse); } });
    const result = await sentinel.runOnce([bonsaiSentinelTile()]);
    expect(result.status).toBe("ok");
    expect(pulses[0]).toMatchObject({ agent: "snarkroute-sentinel", where: "SnarkRoute", schedule: "5m", status: "ok" });
  });

  it("marks a stopped when_running service as off without a failure or ticket", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not be fetched", { status: 503 }));
    const sentinel = new Sentinel({ fetchImpl, portListening: async () => false });
    const result = await sentinel.checkTile({ id: "worker", label: "Worker", url: "http://127.0.0.1:18080", healthPath: "/ready", watch: "when_running" });
    expect(result).toMatchObject({ ok: false, status: "off", failuresInWindow: 0 });
    expect(result.ticket).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await sentinel.runOnce([{ id: "worker", label: "Worker", url: "http://127.0.0.1:18080", healthPath: "/ready", watch: "when_running" }])).status).toBe("ok");
  });

  it("keeps an always service as a health failure when its port is down", async () => {
    const now = new Date("2026-10-20T10:00:00.000Z");
    const sentinel = new Sentinel({
      fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }),
      now: () => now,
      portListening: async () => false
    });
    const tile = { id: "required", label: "Required", url: "http://127.0.0.1:8767", healthPath: "/health", watch: "always" as const };
    expect(await sentinel.checkTile(tile)).toMatchObject({ ok: false, status: "degraded" });
    expect(await sentinel.checkTile(tile)).toMatchObject({ ok: false, status: "stuck", ticket: { reason: "health_failed" } });
  });

  it("uses the registry watch policy and the launcher root health path", () => {
    const tiles = defaultSentinelTiles();
    expect(tiles.find(tile => tile.id === "launcher")).toMatchObject({ healthPath: "/", watch: "always" });
    expect(tiles.find(tile => tile.id === "bonsai_inference")).toMatchObject({ watch: "when_running" });
  });
});
