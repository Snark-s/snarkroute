import cors from "@fastify/cors";
import Fastify from "fastify";
import { ensureDevUsers } from "./auth/adapters";
import { registerAdminRoutes } from "./routes/admin";
import { registerAssetRoutes } from "./routes/assets";
import { registerAuthRoutes } from "./routes/auth";
import { registerBillingRoutes } from "./routes/billing";
import { registerCanvasActionSessionRoutes } from "./routes/canvas-action-sessions";
import { registerDevRoutes } from "./routes/dev";
import { registerExecutionRoutes, registerRunResultRoutes } from "./routes/execution";
import { registerLedgerRoutes } from "./routes/ledger";
import { registerLibraryRoutes } from "./routes/libraries";
import { registerLocalStableDiffusionRoutes } from "./routes/local-stable-diffusion";
import { registerModelIconRoutes } from "./routes/model-icons";
import { registerModelRoutes } from "./routes/models";
import { registerModelGatewayJobRoutes } from "./routes/model-gateway-jobs";
import { registerNodeCatalogRoutes } from "./routes/nodes";
import { registerNodePackageRoutes } from "./routes/node-packages";
import { registerPromptLibraryRoutes, refreshPromptLibraryCache } from "./routes/prompt-library";
import { registerProviderRoutes } from "./routes/providers";
import { registerRouteDocumentRoutes } from "./routes/route-documents";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSystemRoutes } from "./routes/system";
import { registerWorldLabsMarbleRoutes } from "./routes/worldlabs-marble";
import { registerAfterEffectsRoutes } from "./routes/after-effects";
import { registerMcpRoutes } from "./mcp/server";
import { registerPortableToolJobRoutes } from "./routes/tool-jobs";
import { startModelPricingRefreshScheduler } from "./billing/model-pricing-refresh-scheduler";
import { appMode, assertProductionSafety } from "./services/env";
import { loadRootEnv } from "./services/env-loader";
export function buildServer() {
  loadRootEnv();
  assertProductionSafety();
  const app = Fastify({ logger: true, bodyLimit: 250 * 1024 * 1024 });
  app.register(cors, { origin: true, credentials: true });
  registerAfterEffectsRoutes(app);
  void registerMcpRoutes(app);
  void ensureDevUsers();
  void refreshPromptLibraryCache();
  void registerAdminRoutes(app);
  void registerDevRoutes(app);
  void registerAuthRoutes(app);
  void registerBillingRoutes(app);
  void registerSettingsRoutes(app);
  void registerSystemRoutes(app);
  void registerModelRoutes(app);
  void registerModelGatewayJobRoutes(app);
  void registerProviderRoutes(app);
  void registerPortableToolJobRoutes(app);
  void registerNodeCatalogRoutes(app);
  void registerNodePackageRoutes(app);
  void registerCanvasActionSessionRoutes(app);
  void registerRouteDocumentRoutes(app);
  void registerLocalStableDiffusionRoutes(app);
  void registerWorldLabsMarbleRoutes(app);
  void registerPromptLibraryRoutes(app);
  void registerModelIconRoutes(app);
  void registerAssetRoutes(app);
  void registerLibraryRoutes(app);
  void registerExecutionRoutes(app);
  void registerRunResultRoutes(app);
  void registerLedgerRoutes(app);
  startModelPricingRefreshScheduler();
  return app;
}

function localCorsOrigin(origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void): void {
  if (!origin) return callback(null, true);
  if (appMode() === "local" && (origin === "null" || origin.startsWith("file://"))) return callback(null, true);
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const configuredOrigins = [process.env.APP_WEB_URL, process.env.PUBLIC_APP_URL]
      .flatMap((value) => { try { return value?.trim() ? [new URL(value).origin] : []; } catch { return []; } });
    callback(null, hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost") || configuredOrigins.includes(parsed.origin));
  } catch {
    callback(null, false);
  }
}
