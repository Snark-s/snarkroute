import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerAssetRoutes } from "./routes/assets";
import { registerExecutionRoutes, registerRunResultRoutes } from "./routes/execution";
import { registerLedgerRoutes } from "./routes/ledger";
import { registerLocalStableDiffusionRoutes } from "./routes/local-stable-diffusion";
import { registerNodeCatalogRoutes } from "./routes/nodes";
import { registerNodePackageRoutes } from "./routes/node-packages";
import { registerPromptLibraryRoutes, refreshPromptLibraryCache } from "./routes/prompt-library";
import { registerProviderRoutes } from "./routes/providers";
import { registerRouteDocumentRoutes } from "./routes/route-documents";
import { registerSettingsRoutes } from "./routes/settings";
export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 250 * 1024 * 1024 });
  app.register(cors, { origin: true });
  void refreshPromptLibraryCache();
  void registerSettingsRoutes(app);
  void registerProviderRoutes(app);
  void registerNodeCatalogRoutes(app);
  void registerNodePackageRoutes(app);
  void registerRouteDocumentRoutes(app);
  void registerLocalStableDiffusionRoutes(app);
  void registerPromptLibraryRoutes(app);
  void registerAssetRoutes(app);
  void registerExecutionRoutes(app);
  void registerRunResultRoutes(app);
  void registerLedgerRoutes(app);
  return app;
}