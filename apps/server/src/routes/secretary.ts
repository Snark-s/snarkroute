import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { secretaryInbox, SecretaryInboxError, type SecretaryQuestions } from "../services/secretary-inbox";

type Inbox = { questions: (fresh?: boolean) => Promise<SecretaryQuestions>; answer: (id: string, answer: string, expectedQuestion: string) => Promise<SecretaryQuestions> };
const answerSchema = z.object({ answer: z.string().trim().min(1).max(10_000), expectedQuestion: z.string().min(1).max(20_000) }).strict();

export function registerSecretaryRoutes(app: FastifyInstance, local: (request: FastifyRequest) => boolean, inbox: Inbox = secretaryInbox) {
  const failure = (error: unknown) => error instanceof SecretaryInboxError ? error : new SecretaryInboxError(503, "Реестр Секретаря недоступен. Попробуй позже.");
  app.get<{ Querystring: { refresh?: string } }>("/api/system/secretary/questions", async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Доступно только из локальной мастерской." });
    reply.header("Cache-Control", "no-store");
    try { return { ok: true, ...await inbox.questions(request.query.refresh === "1") }; }
    catch (error) { const reason = failure(error); return reply.code(reason.statusCode).send({ ok: false, error: reason.message }); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/system/secretary/questions/:id/answer", { bodyLimit: 131_072 }, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ ok: false, error: "Доступно только из локальной мастерской." });
    reply.header("Cache-Control", "no-store");
    const parsed = answerSchema.safeParse(request.body);
    if (!/^\d{1,20}$/.test(request.params.id) || !parsed.success) return reply.code(400).send({ ok: false, error: "Укажи вопрос и непустой ответ длиной до 10 000 символов." });
    try { return { ok: true, ...await inbox.answer(request.params.id, parsed.data.answer, parsed.data.expectedQuestion) }; }
    catch (error) { const reason = failure(error); return reply.code(reason.statusCode).send({ ok: false, error: reason.message }); }
  });
}
