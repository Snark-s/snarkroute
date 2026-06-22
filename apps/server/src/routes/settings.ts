import type { FastifyInstance } from "fastify";
import { appCapabilities, isElevenLabsEnabled, isGeminiEnabled, isOpenAiEnabled, isOpenRouterEnabled, isPolzaEnabled, isReplicateEnabled, isSeedanceEnabled, isWorldLabsEnabled, maskSecret, stringValue, writeEnvValue } from "../services/env";
import { errorMessage } from "../services/errors";
import { openRouterSettingsStatus } from "../providers/openrouter";
import { normalizeSeedanceBackend, seedanceSettingsStatus, SEEDANCE_BACKENDS } from "../providers/seedance";
export async function registerSettingsRoutes(app: FastifyInstance) {
app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled: isReplicateEnabled(), geminiEnabled: isGeminiEnabled(), openaiEnabled: isOpenAiEnabled(), openrouterEnabled: isOpenRouterEnabled(), polzaEnabled: isPolzaEnabled(), elevenlabsEnabled: isElevenLabsEnabled(), seedanceEnabled: isSeedanceEnabled(), worldLabsEnabled: isWorldLabsEnabled() }));

app.get("/api/capabilities", async () => appCapabilities());

app.get("/api/settings", async () => ({
  replicate: { configured: isReplicateEnabled() },
  gemini: { configured: isGeminiEnabled() },
  polza: { configured: isPolzaEnabled(), maskedApiKey: isPolzaEnabled() ? maskSecret(process.env.POLZA_AI_API_KEY) : "" },
  elevenlabs: { configured: isElevenLabsEnabled(), maskedApiKey: isElevenLabsEnabled() ? maskSecret(process.env.ELEVENLABS_API_KEY) : "" },
  openai: { configured: isOpenAiEnabled(), maskedApiKey: isOpenAiEnabled() ? maskSecret(process.env.OPENAI_API_KEY) : "" },
  worldlabs: { configured: isWorldLabsEnabled(), maskedApiKey: isWorldLabsEnabled() ? maskSecret(process.env.WORLDS_API_KEY) : "" },
  seedance: seedanceSettingsStatus(),
  openrouter: await openRouterSettingsStatus()
}));

app.post<{ Body: { seedanceApiKey?: string; seedanceApiBaseUrl?: string; backend?: string } }>("/api/settings/seedance-token", async (request, reply) => {
  const token = request.body?.seedanceApiKey?.trim();
  const backend = normalizeSeedanceBackend(request.body?.backend);
  const baseUrl = stringValue(request.body?.seedanceApiBaseUrl);
  if (request.body?.backend !== undefined && !backend) return reply.code(400).send({ error: "Seedance provider backend is not selected" });
  if (token && !/^[\x21-\x7E]+$/.test(token)) return reply.code(400).send({ error: "Seedance API key is invalid. Paste the real provider key, not masked text or help text." });
  if (!token && !backend && request.body?.seedanceApiBaseUrl === undefined) return reply.code(400).send({ error: "Seedance settings payload is empty." });
  try {
    if (backend) {
      await writeEnvValue("SEEDANCE_PROVIDER_BACKEND", backend);
      process.env.SEEDANCE_PROVIDER_BACKEND = backend;
    }
    if (token) {
      const key = backend ? SEEDANCE_BACKENDS[backend].apiKeyEnvKeys[0] : "SEEDANCE_API_KEY";
      await writeEnvValue(key, token);
      process.env[key] = token;
      process.env.SEEDANCE_API_KEY = token;
    }
    if (request.body?.seedanceApiBaseUrl !== undefined) {
      await writeEnvValue("SEEDANCE_API_BASE_URL", baseUrl ?? "");
      process.env.SEEDANCE_API_BASE_URL = baseUrl ?? "";
    }
    return { ok: true, seedance: seedanceSettingsStatus() };
  } catch (error) {
    return reply.code(500).send({ error: errorMessage(error) });
  }
});

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

app.post<{ Body: { elevenLabsApiKey?: string; defaultVoiceId?: string } }>("/api/settings/elevenlabs-token", async (request, reply) => {
  const token = request.body?.elevenLabsApiKey?.trim();
  const defaultVoiceId = stringValue(request.body?.defaultVoiceId);
  if (!token && defaultVoiceId === undefined) return reply.code(400).send({ error: "ElevenLabs settings payload is empty." });
  try {
    if (token) {
      await writeEnvValue("ELEVENLABS_API_KEY", token);
      process.env.ELEVENLABS_API_KEY = token;
    }
    if (defaultVoiceId !== undefined) {
      await writeEnvValue("ELEVENLABS_DEFAULT_VOICE_ID", defaultVoiceId);
      process.env.ELEVENLABS_DEFAULT_VOICE_ID = defaultVoiceId;
    }
    return { ok: true, elevenlabs: { configured: isElevenLabsEnabled(), maskedApiKey: isElevenLabsEnabled() ? maskSecret(process.env.ELEVENLABS_API_KEY) : "" } };
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

app.post<{ Body: { worldsApiKey?: string } }>("/api/settings/worldlabs-token", async (request, reply) => {
  const token = request.body?.worldsApiKey?.trim();
  if (!token) return reply.code(400).send({ error: "WORLDS_API_KEY cannot be empty." });
  try {
    await writeEnvValue("WORLDS_API_KEY", token);
    process.env.WORLDS_API_KEY = token;
    return { ok: true, worldlabs: { configured: true, maskedApiKey: maskSecret(token) } };
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
