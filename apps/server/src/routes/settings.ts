import type { FastifyInstance } from "fastify";
import { isGeminiEnabled, isOpenAiEnabled, isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled, maskSecret, stringValue, writeEnvValue } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterSettingsStatus } from "../providers/openrouter";
export async function registerSettingsRoutes(app: FastifyInstance) {
app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled: isReplicateEnabled(), geminiEnabled: isGeminiEnabled(), openaiEnabled: isOpenAiEnabled(), polzaEnabled: isPolzaEnabled() }));

app.get("/api/settings", async () => ({
  replicate: { configured: isReplicateEnabled() },
  gemini: { configured: isGeminiEnabled() },
  polza: { configured: isPolzaEnabled(), maskedApiKey: isPolzaEnabled() ? maskSecret(process.env.POLZA_AI_API_KEY) : "" },
  openai: { configured: isOpenAiEnabled(), maskedApiKey: isOpenAiEnabled() ? maskSecret(process.env.OPENAI_API_KEY) : "" },
  openrouter: await openRouterSettingsStatus()
}));

app.post<{ Body: { polzaAiApiKey?: string } }>("/api/settings/polza-token", async (request, reply) => {
  const token = request.body?.polzaAiApiKey?.trim();
  if (!token) return reply.code(400).send({ error: "POLZA_AI_API_KEY cannot be empty." });
  try {
    await writeEnvValue("POLZA_AI_API_KEY", token);
    process.env.POLZA_AI_API_KEY = token;
    return { ok: true, polza: { configured: true, maskedApiKey: maskSecret(token) } };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { replicateApiToken?: string } }>("/api/settings/replicate-token", async (request, reply) => {
  const token = request.body?.replicateApiToken?.trim();
  if (!token) return reply.code(400).send({ error: "REPLICATE_API_TOKEN cannot be empty." });
  try {
    await writeEnvValue("REPLICATE_API_TOKEN", token);
    process.env.REPLICATE_API_TOKEN = token;
    return { ok: true, replicate: { configured: true } };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { geminiApiKey?: string } }>("/api/settings/gemini-token", async (request, reply) => {
  const token = request.body?.geminiApiKey?.trim();
  if (!token) return reply.code(400).send({ error: "GEMINI_API_KEY cannot be empty." });
  try {
    await writeEnvValue("GEMINI_API_KEY", token);
    process.env.GEMINI_API_KEY = token;
    return { ok: true, gemini: { configured: true } };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { openAiApiKey?: string } }>("/api/settings/openai-token", async (request, reply) => {
  const token = request.body?.openAiApiKey?.trim();
  if (!token) return reply.code(400).send({ error: "OPENAI_API_KEY cannot be empty." });
  try {
    await writeEnvValue("OPENAI_API_KEY", token);
    process.env.OPENAI_API_KEY = token;
    return { ok: true, openai: { configured: true, maskedApiKey: maskSecret(token) } };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

app.post<{ Body: { openRouterApiKey?: string; defaultModel?: string; budgetWarningUsd?: number | string | null } }>("/api/settings/openrouter", async (request, reply) => {
  const token = request.body?.openRouterApiKey?.trim();
  const defaultModel = stringValue(request.body?.defaultModel);
  const budgetWarningUsd = request.body?.budgetWarningUsd;
  try {
    if (token) {
      await writeEnvValue("OPENROUTER_API_KEY", token);
      process.env.OPENROUTER_API_KEY = token;
    }
    if (defaultModel !== undefined) {
      await writeEnvValue("OPENROUTER_DEFAULT_MODEL", defaultModel);
      process.env.OPENROUTER_DEFAULT_MODEL = defaultModel;
    }
    if (budgetWarningUsd !== undefined && budgetWarningUsd !== null) {
      await writeEnvValue("OPENROUTER_BUDGET_WARNING_USD", String(budgetWarningUsd));
      process.env.OPENROUTER_BUDGET_WARNING_USD = String(budgetWarningUsd);
    }
    if (!token && defaultModel === undefined && budgetWarningUsd === undefined) return reply.code(400).send({ error: "OpenRouter settings payload is empty." });
    return { ok: true, openrouter: await openRouterSettingsStatus() };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});
}
