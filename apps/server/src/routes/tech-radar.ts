import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { errorMessage } from "../services/errors";
import { techRadarService, type TechRadarService } from "../services/tech-radar/service";
import type { Project, Research } from "../services/tech-radar/types";

const enqueueSchema = z.object({ url: z.string().min(1).max(2048), repeat: z.boolean().optional() }).strict();
const decisionSchema = z.object({ status: z.enum(["skip", "watch", "test", "review_integration"]), note: z.string().max(4000).optional() }).strict();
const watchSchema = z.object({ enabled: z.boolean(), intervalDays: z.number().int().min(1).max(365).optional() }).strict();

export function registerTechRadarRoutes(app: FastifyInstance, service: TechRadarService = techRadarService()) {
  app.addHook("onReady", async () => { try { await service.init(); service.startScheduler(); } catch { app.log.error("Технорадар: каталог недоступен; остальные функции сервера продолжают работать."); } });
  app.addHook("onClose", async () => service.close());
  const handle = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try { return await work(); } catch (error) { return reply.code(/не найден/i.test(errorMessage(error)) ? 404 : /каталог/i.test(errorMessage(error)) ? 503 : 400).send({ error: errorMessage(error) }); }
  };
  app.get("/api/tech-radar", async (_request, reply) => handle(reply, async () => {
    const state = await service.catalog();
    return { projects: state.projects.map(p => publicProject(p, false)), jobs: state.jobs.map(({ snapshot, ...job }) => ({ ...job, savedSourceCount: snapshot?.sources.length ?? 0 })), inventory: state.inventory, capabilities: await service.capabilities() };
  }));
  app.post("/api/tech-radar/projects", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = enqueueSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Нужна GitHub-ссылка и необязательный флаг repeat." });
    return handle(reply, async () => { const result = await service.enqueue(parsed.data.url, parsed.data.repeat); reply.code(result.duplicate ? 200 : 202); return result; });
  });
  app.get<{ Params: { id: string } }>("/api/tech-radar/projects/:id", async (request, reply) => handle(reply, async () => {
    const state = await service.catalog(); const project = state.projects.find(p => p.id === request.params.id);
    if (!project) throw new Error("Проект не найден.");
    return { project: publicProject(project), jobs: state.jobs.filter(j => j.projectId === project.id).map(j => ({ ...j, snapshot: j.snapshot ? { ...j.snapshot, sources: j.snapshot.sources.map(({ text, ...s }) => s) } : undefined })) };
  }));
  app.post<{ Params: { id: string } }>("/api/tech-radar/projects/:id/decisions", { bodyLimit: 16_384 }, async (request, reply) => {
    const parsed = decisionSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Некорректное решение." });
    return handle(reply, async () => ({ project: publicProject(await service.decide(request.params.id, parsed.data.status, parsed.data.note)) }));
  });
  app.patch<{ Params: { id: string } }>("/api/tech-radar/projects/:id/watch", async (request, reply) => {
    const parsed = watchSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "Нужен флаг enabled; intervalDays от 1 до 365." });
    return handle(reply, async () => ({ project: publicProject(await service.watch(request.params.id, parsed.data.enabled, parsed.data.intervalDays)) }));
  });
  app.post<{ Params: { id: string } }>("/api/tech-radar/projects/:id/acknowledge", async (request, reply) => handle(reply, async () => ({ project: publicProject(await service.acknowledge(request.params.id)) })));
  app.get("/api/tech-radar/capabilities", async (_request, reply) => handle(reply, async () => ({ capabilities: await service.capabilities() })));
}
function publicResearch(research: Research) { return { ...research, snapshot: { ...research.snapshot, sources: research.snapshot.sources.map(({ text, ...source }) => source) } }; }
function publicProject(project: Project, history = true) { return { ...project, researchCount: project.research.length, research: (history ? project.research : project.research.slice(-1)).map(publicResearch) }; }
