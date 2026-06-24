import type { FastifyInstance } from "fastify";
import { getAuthAdapter } from "../auth/adapters";
import { clearSessionCookie, finishOAuth, startOAuth } from "../auth/oauth";
import { errorMessage } from "../services/errors";

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/auth/current", async (request, reply) => {
    try {
      return { user: await getAuthAdapter().getCurrentUser(request) };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/auth/me", async (request, reply) => {
    try {
      return { user: await getAuthAdapter().getCurrentUser(request) };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    try {
      return { user: await getAuthAdapter().login(request) };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    try {
      const result = await getAuthAdapter().logout(request);
      clearSessionCookie(reply);
      return result;
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/auth/google/start", async (request, reply) => {
    try {
      return await startOAuth("google", request, reply);
    } catch (error) {
      return reply.code(authErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/auth/google/callback", async (request, reply) => {
    try {
      return await finishOAuth("google", request, reply);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/auth/yandex/start", async (request, reply) => {
    try {
      return await startOAuth("yandex", request, reply);
    } catch (error) {
      return reply.code(authErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/auth/yandex/callback", async (request, reply) => {
    try {
      return await finishOAuth("yandex", request, reply);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function authErrorStatus(error: unknown): number {
  return errorMessage(error).startsWith("Cloud auth is not configured.") ? 503 : 500;
}
