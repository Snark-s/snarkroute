import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { codexCliCommand, codexCliEnv, CodexCliError } from "../services/codex-cli";
import { CHATGPT_DEFAULT_ALIAS, chatGptSubscription, isChatGptSubscriptionEnabled, modelRefForAlias, type ChatGptSubscriptionService } from "../services/chatgpt-subscription";
import { errorMessage } from "../services/errors";
import { isLocalClient as local } from "./subscription-common";

const ROOT = "/api/chatgpt-subscription";
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The owner's ChatGPT plan for the owner's own SnarkRoute: loopback clients only,
 * no accounts and no forwarding to other users. Text inference for routes goes
 * through the standard ai.text runner; this surface adds status, login and conversations.
 */
export function registerChatGptSubscriptionRoutes(app: FastifyInstance, service: ChatGptSubscriptionService = chatGptSubscription()): void {
  app.get<{ Querystring: { refresh?: string } }>(`${ROOT}/status`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    if (request.query.refresh === "1") await service.auth(true);
    return reply.header("cache-control", "no-store").send({ ok: true, enabled: isChatGptSubscriptionEnabled(), ...(await service.status()) });
  });

  /** Opens the official `codex login` (ChatGPT sign-in in the browser) in its own console window. */
  app.post(`${ROOT}/login`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    const auth = await service.auth(true);
    if (!auth.installed) return reply.code(409).send({ ok: false, auth });
    if (auth.subscription) return { ok: true, alreadyLoggedIn: true, auth };
    if (auth.loggedIn) return reply.code(409).send({ ok: false, auth, message: "Codex вошёл по API-ключу. Сначала codex logout, затем вход через ChatGPT." });
    const command = await codexCliCommand();
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/c", "start", "\"Codex login\"", `"${command}"`, "login"], { env: codexCliEnv(), detached: true, stdio: "ignore", windowsVerbatimArguments: true })
      : spawn(command, ["login"], { env: codexCliEnv(), detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return { ok: true, started: true, message: "Окно входа Codex открыто. Войдите через ChatGPT и обновите статус." };
  });

  app.post<{ Body: { seconds?: number } }>(`${ROOT}/quota/simulate-exhausted`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    return { ok: true, quota: service.simulateQuotaExhausted(Number(record(request.body).seconds) || 120) };
  });

  app.delete(`${ROOT}/quota/simulate-exhausted`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    return { ok: true, quota: service.clearSimulatedQuota() };
  });

  app.get(`${ROOT}/conversations`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    return { ok: true, conversations: await service.listConversations() };
  });

  app.delete<{ Params: { id: string } }>(`${ROOT}/conversations/:id`, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    return { ok: await service.forgetConversation(request.params.id) };
  });

  app.post(`${ROOT}/chat`, { bodyLimit: 400_000 }, async (request, reply) => {
    if (!local(request)) return reply.code(403).send({ error: { message: "Local client required." } });
    if (!isChatGptSubscriptionEnabled()) return reply.code(409).send({ error: { code: "PROVIDER_DISABLED", message: "ChatGPT Subscription выключен (CHATGPT_SUBSCRIPTION_ENABLED=1)." } });
    const body = record(request.body);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : modelRefForAlias(CHATGPT_DEFAULT_ALIAS);
    const system = typeof body.system === "string" ? body.system : undefined;
    const conversationId = body.conversationId === "new" ? randomUUID() : typeof body.conversationId === "string" ? body.conversationId : undefined;
    if (!prompt.trim() || prompt.length > 200_000) return reply.code(400).send({ error: { message: "prompt is required (up to 200000 characters)." } });
    if (conversationId && !CONVERSATION_ID.test(conversationId)) return reply.code(400).send({ error: { message: "conversationId must match [A-Za-z0-9_-]{1,80} or be \"new\"." } });
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
    const chat = (onEvent?: Parameters<ChatGptSubscriptionService["chat"]>[0]["onEvent"]) =>
      service.chat({ modelRef: model, prompt, systemPrompt: system, conversationId, signal: controller.signal, caller: "api:chatgpt-subscription", onEvent });

    if (body.stream !== true) {
      try { return { ok: true, ...(await chat()) }; }
      catch (error) { return sendError(reply, error); }
    }
    // Codex exec emits only the final message: the stream carries session/warning/rate_limit and done, no text deltas.
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const send = (event: string, data: unknown) => { if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      const result = await chat(event => {
        if (event.type === "session") send("session", { conversationId });
        else if (event.type === "warning") send("warning", { message: event.message });
        else if (event.type === "rate_limit") send("rate_limit", { planType: event.info.planType, primary: event.info.primary, secondary: event.info.secondary });
      });
      send("done", result);
    } catch (error) {
      send("error", errorBody(error));
    } finally {
      reply.raw.end();
    }
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  const body = errorBody(error);
  const status = body.code === "SUBSCRIPTION_LIMIT_REACHED" ? 429
    : body.code === "NOT_LOGGED_IN" || body.code === "NOT_SUBSCRIPTION" ? 401
      : body.code === "CANCELLED" ? 499 : body.code === "MODEL_UNAVAILABLE" ? 404 : 502;
  return reply.code(status).send({ ok: false, error: body });
}

function errorBody(error: unknown): { code: string; message: string; resetsAt?: string; retryable: boolean } {
  if (error instanceof CodexCliError) return { code: error.code, message: error.message, resetsAt: error.details.resetsAt, retryable: error.retryable };
  return { code: "CLI_ERROR", message: errorMessage(error), retryable: false };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
