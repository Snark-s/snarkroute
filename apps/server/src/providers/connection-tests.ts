import {
  failedProviderConnection,
  unsupportedProviderConnection,
  verifiedProviderConnection,
  type ProviderAdapter,
  type ProviderConnectionTest
} from "@snarkroute/core";
import { createGeminiProviderAdapter } from "@snarkroute/gemini";
import { createKieClient, listDocumentedKieModels } from "@snarkroute/kie";
import { createOpenRouterProviderAdapter } from "@snarkroute/openrouter";
import { createPolzaClient } from "@snarkroute/polza";
import { createReplicateProviderAdapter } from "@snarkroute/replicate";
import { createExperientialClient } from "./experiential";
import { validateSeedanceConfiguration } from "./seedance";

export async function testProviderConnection(provider: string): Promise<ProviderConnectionTest> {
  switch (provider.trim().toLowerCase()) {
    case "gemini":
      return testAdapter(createGeminiProviderAdapter());
    case "replicate":
      return testAdapter(createReplicateProviderAdapter());
    case "openrouter":
      return testAdapter(createOpenRouterProviderAdapter());
    case "experiential":
      return runLiveTest("Experiential Labs", async () => {
        const models = await createExperientialClient().getModels();
        return verifiedProviderConnection("Experiential Labs credentials verified.", { modelCount: models.length });
      });
    case "kie":
      return runLiveTest("KIE.ai", async () => {
        const credits = await createKieClient().getCredits();
        return verifiedProviderConnection("KIE.ai credentials verified.", { credits, modelCount: listDocumentedKieModels().length });
      });
    case "polza":
      return runLiveTest("Polza", async () => {
        const models = await createPolzaClient().getModels("chat");
        return verifiedProviderConnection("Polza credentials verified.", { modelCount: models.length });
      });
    case "seedance": {
      const configuration = validateSeedanceConfiguration();
      if (!configuration.ok) return failedProviderConnection("Seedance", new Error(configuration.error));
      return {
        ...unsupportedProviderConnection("Live connection test is not implemented for this Seedance backend."),
        details: { seedance: configuration.status }
      };
    }
    case "rutronix":
      return unsupportedProviderConnection("Live connection test is not implemented for RuTronix.");
    case "openai":
      return unsupportedProviderConnection("Live connection test is not implemented for OpenAI.");
    default:
      return unsupportedProviderConnection(`Live connection test is not implemented for provider "${provider}".`);
  }
}

async function testAdapter(adapter: ProviderAdapter): Promise<ProviderConnectionTest> {
  if (!adapter.testConnection) return unsupportedProviderConnection(`Live connection test is not implemented for ${adapter.title}.`);
  return adapter.testConnection();
}

async function runLiveTest(provider: string, test: () => Promise<ProviderConnectionTest>): Promise<ProviderConnectionTest> {
  try {
    return await test();
  } catch (error) {
    return failedProviderConnection(provider, error);
  }
}
