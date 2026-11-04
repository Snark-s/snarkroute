import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentOpsStore } from "./store";
import { factorySource, jabberwockSource, registerProjectionSource, toveSource, WorkRegistry, type ProjectionSource } from "./registry";
import type { AgentIdentity } from "./types";

const who = (id: string, kind: AgentIdentity["kind"] = "app") => ({ id, kind, label: id, policy: { level: 3 } }) as unknown as AgentIdentity;

describe("D4: work registry projections", () => {
  let directory: string;
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "agent-ops-registry-")); });
  afterAll(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

  it("maps Tove goals and Factory lines and obstacles onto shared states", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("/api/goals") ? { goals: [
        { id: "g1", title: "Выручка", status: "active", stalled: 4, target: 0.01, last_value: 0, updated_at: "2026-11-04T09:00:00Z" },
        { id: "g2", title: "Реестр", status: "needs_review", stalled: 13, verified_units: 2, updated_at: "2026-11-04T09:00:00Z" },
        { id: "g3", title: "Отчёт", status: "active", stalled: 0, updated_at: "2026-11-04T09:00:00Z" }] }
      : url.endsWith("/api/status") ? { lines: [{ id: "adobe_stock", name: "Adobe Stock", status: "pilot", status_label: "пилот", sales: { note: "продаж нет" } }] }
      : { obstacles: [{ id: "o1", title: "Нет модели", status: "open", needs: "technical", line_id: "apparel_u2y" }, { id: "o2", title: "Закрыто", status: "resolved" }] }))));
    const tove = await toveSource("http://t").fetch();
    expect(tove.map(item => [item.externalId, item.state])).toEqual([["g1", "stalled"], ["g2", "needs_owner"], ["g3", "active"]]);
    expect(tove[0].progress).toBe("0 из 0.01");
    const factory = await factorySource("http://f").fetch();
    expect(factory.map(item => [item.externalId, item.state])).toEqual([["line:adobe_stock", "active"], ["obstacle:o1", "stalled"]]);
    vi.unstubAllGlobals();
  });

  it("projects Jabberwock routes and includes sources registered by other modules", async () => {
    const source = jabberwockSource(() => [{ id: "route_1", objective: "Собрать сайт", status: "blocked", summary: null, blocked: JSON.stringify({ message: "нет модели" }), updatedAt: "2026-11-04T09:00:00Z", steps: 4, done: 1 }]);
    expect(await source.fetch()).toMatchObject([{ externalId: "route_1", state: "stalled", progress: "шагов 1 из 4", detail: "нет модели" }]);
    registerProjectionSource(source);
    const registry = new WorkRegistry({ store: new AgentOpsStore(join(directory, "data-j")), sources: [], includeRegistered: true });
    const view = await registry.list();
    expect(view.items.map(item => item.system)).toEqual(["jabberwock"]);
    expect(view.sources.jabberwock).toMatchObject({ ok: true, count: 1 });
  });

  it("keeps the last known items of a source that went down, and lets only the system itself push", async () => {
    let fail = false;
    const source: ProjectionSource = { system: "tove", label: "Tove", fetch: async () => { if (fail) throw new Error("connection refused"); return [{ externalId: "g1", title: "Цель", state: "active", updatedAt: "2026-11-04T09:00:00Z" }]; } };
    const registry = new WorkRegistry({ store: new AgentOpsStore(join(directory, "data")), sources: [source] });
    await registry.init();
    expect((await registry.list()).items).toHaveLength(1);
    fail = true;
    const stale = await registry.list({ refresh: true });
    expect(stale.items).toHaveLength(1);
    expect(stale.sources.tove).toMatchObject({ ok: false, error: "connection refused" });

    await expect(registry.push(who("app:tove"), "factory", "x", { title: "t", state: "active" })).rejects.toThrow(/app:factory/);
    await expect(registry.push(who("app:factory"), "factory", "x", { title: "t", state: "weird" })).rejects.toThrow(/state/);
    await registry.push(who("app:factory"), "factory", "job-1", { title: "Партия", state: "needs_owner", goalId: "g-20261104-00000000" });
    const again = new WorkRegistry({ store: new AgentOpsStore(join(directory, "data")), sources: [] });
    await again.init();
    expect((await again.list()).items).toMatchObject([{ system: "factory", externalId: "job-1", state: "needs_owner", source: "push" }]);
  });
});
