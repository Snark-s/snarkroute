import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTechRadarRoutes } from "./tech-radar";
import type { TechRadarService } from "../services/tech-radar/service";
import type { Project } from "../services/tech-radar/types";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function fixture() {
  const project: Project = { id: "tech_1", sourceType: "github", sourceKey: "github:demo/studio", canonicalUrl: "https://github.com/demo/studio", name: "studio", createdAt: "2026-10-25", research: [], decisions: [], watch: { enabled: false, intervalDays: 7 } };
  const service = { init: vi.fn(async () => undefined), startScheduler: vi.fn(), close: vi.fn(async () => undefined), catalog: vi.fn(async () => ({ schemaVersion: 1, projects: [project], jobs: [], inventory: [] })), capabilities: vi.fn(async () => []), enqueue: vi.fn(async () => ({ projectId: "tech_1", jobId: "job", duplicate: false })), decide: vi.fn(async (_id, status, note) => ({ ...project, decisions: [{ status, note, at: "2026-10-25" }] })), watch: vi.fn(async (_id, enabled, intervalDays) => ({ ...project, watch: { enabled, intervalDays } })), acknowledge: vi.fn(async () => project) };
  const app = Fastify(); apps.push(app); registerTechRadarRoutes(app, service as unknown as TechRadarService);
  return { app, service };
}
describe("Tech Radar HTTP contract", () => {
  it("submits, lists, opens and persists owner decisions through the service", async () => {
    const { app, service } = fixture();
    const submit = await app.inject({ method: "POST", url: "/api/tech-radar/projects", payload: { url: "https://github.com/demo/studio" } });
    expect(submit.statusCode).toBe(202); expect(service.enqueue).toHaveBeenCalledWith("https://github.com/demo/studio", undefined);
    expect((await app.inject("/api/tech-radar")).json().projects[0].researchCount).toBe(0);
    expect((await app.inject("/api/tech-radar/projects/tech_1")).statusCode).toBe(200);
    const decision = await app.inject({ method: "POST", url: "/api/tech-radar/projects/tech_1/decisions", payload: { status: "watch", note: "Позже" } });
    expect(decision.json().project.decisions[0].status).toBe("watch"); expect(service.decide).toHaveBeenCalledWith("tech_1", "watch", "Позже");
    expect((await app.inject({ method: "PATCH", url: "/api/tech-radar/projects/tech_1/watch", payload: { enabled: true, intervalDays: 7 } })).statusCode).toBe(200);
    expect((await app.inject("/api/tech-radar/capabilities")).json().capabilities).toEqual([]);
  });
  it("rejects invalid bodies, returns duplicate identity and isolates service errors", async () => {
    const { app, service } = fixture();
    for (const payload of [{}, { url: 12 }, { url: "https://github.com/a/b", install: true }, { url: "x", repeat: "yes" }]) expect((await app.inject({ method: "POST", url: "/api/tech-radar/projects", payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/tech-radar/projects/tech_1/decisions", payload: { status: "implement" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/tech-radar/projects/tech_1/watch", payload: { enabled: true, intervalDays: 0 } })).statusCode).toBe(400);
    expect((await app.inject("/api/tech-radar/projects/missing")).statusCode).toBe(404);
    service.enqueue.mockResolvedValueOnce({ projectId: "tech_1", jobId: "job", duplicate: true });
    expect((await app.inject({ method: "POST", url: "/api/tech-radar/projects", payload: { url: "https://github.com/demo/studio" } })).statusCode).toBe(200);
    service.catalog.mockRejectedValueOnce(new Error("Каталог повреждён"));
    expect((await app.inject("/api/tech-radar")).statusCode).toBe(503);
  });
});
