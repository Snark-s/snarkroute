import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { createExecutor, type NodeRunner } from "@snarkroute/executor";
import { createGeminiLlmNodeRunner, createNanoBanana2NodeRunner } from "@snarkroute/gemini";
import {
  createModelResolver,
  createOpenRouterImageNodeRunner,
  createOpenRouterClient,
  createOpenRouterTextNodeRunner,
  readOpenRouterModelCatalogCache,
  refreshOpenRouterModelCatalog,
  resolutionMetadata,
  type ModelMapping,
  type OpenRouterModelInfo,
  type ProviderMode
} from "@snarkroute/openrouter";
import {
  builtInNodeManifests,
  formatIssues,
  getInstalledNodesDirectory,
  getLocalAssetMetadata,
  installNodePackageFromManifest,
  installNodePackageFromArchive,
  previewNodePackageArchive,
  isSupportedRemoteUrl,
  loadInstalledNodeManifests,
  nodeManifestToCatalogEntry,
  registerBuiltInNodeRunners,
  registerInstalledNodeRunners,
  setInstalledNodeEnabled,
  summarizePromptLibrary,
  uninstallInstalledNode,
  validateNodeLibraryManifest,
  validateNodeManifest,
  validatePromptLibraryNodes,
  validateRouteNodeTypes,
  getPromptLibraryPrompt,
  getPromptLibraryPath,
  loadPromptLibrary,
  type LocalAssetKind,
  type PromptLibrary,
  type SnarkNodeManifest
} from "@snarkroute/nodes";
import { loadRouteFromText, parseRoute, validateRoute } from "@snarkroute/protocol";
import { createClarityUpscalerNodeRunner, createReplicateClient, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createLocalRunStorage } from "@snarkroute/storage";

dotenv.config();

const port = Number(process.env.API_PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";
const storage = createLocalRunStorage(join(process.cwd(), "data", "runs"));
const envPath = join(process.cwd(), ".env");
const assetsDirectory = join(process.cwd(), "data", "assets");
const providerLinksPath = findExistingFile("data", "provider-links.json");
const openRouterMappingsPath = findExistingFile("data", "model-registry", "openrouter-mappings.json");
const openRouterCatalogCachePath = join(process.cwd(), "data", "cache", "openrouter-models.json");
const examplesDirectory = findExistingDirectory("examples", "routes");
const getLedgerPath = () => process.env.SNARKROUTE_LEDGER_PATH ?? join(process.cwd(), "data", "ledger", "runs.jsonl");
let promptLibraryCache: PromptLibrary = { categories: [], diagnostics: [] };

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 250 * 1024 * 1024 });
  app.register(cors, { origin: true });
  void refreshPromptLibraryCache();

  app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled: isReplicateEnabled(), geminiEnabled: isGeminiEnabled() }));

  app.get("/api/settings", async () => ({
    replicate: { configured: isReplicateEnabled() },
    gemini: { configured: isGeminiEnabled() },
    openrouter: await openRouterSettingsStatus()
  }));

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

  app.get("/api/providers/links", async (request, reply) => {
    try {
      return JSON.parse(await readFile(providerLinksPath, "utf8"));
    } catch (error) {
      return reply.code(500).send({ error: `Provider links are unavailable: ${errorMessage(error)}` });
    }
  });

  app.get("/api/providers/openrouter/status", async () => ({ openrouter: await openRouterSettingsStatus() }));

  app.post("/api/providers/openrouter/test", async (request, reply) => {
    try {
      if (!isOpenRouterEnabled()) return reply.code(400).send({ ok: false, error: "OpenRouter API key is not set" });
      const result = await createOpenRouterClient().testConnection();
      return { ok: true, status: "connected", message: "Connected", modelCount: result.modelCount };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: openRouterPublicError(error) });
    }
  });

  app.post("/api/providers/openrouter/refresh-model-catalog", async (request, reply) => {
    try {
      const cache = await refreshOpenRouterModelCatalog({ cachePath: openRouterCatalogCachePath });
      return { ok: true, refreshedAt: cache.refreshedAt, modelCount: cache.models.length, models: cache.models };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: `OpenRouter catalog refresh failed: ${openRouterPublicError(error)}` });
    }
  });

  app.get("/api/providers/openrouter/models", async () => {
    const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
    return { ok: true, refreshedAt: cache?.refreshedAt ?? null, modelCount: cache?.models.length ?? 0, models: cache?.models ?? [] };
  });

  app.get("/api/nodes", async () => {
    const installed = await loadInstalledNodeManifests();
    return {
      nodes: [
        ...builtInNodeManifests.map(nodeManifestToCatalogEntry),
        ...providerNodeManifests().map(nodeManifestToCatalogEntry),
        ...installed.filter((manifest) => manifest.enabled !== false).map(nodeManifestToCatalogEntry)
      ],
      installedDirectory: getInstalledNodesDirectory()
    };
  });

  app.get("/api/node-packages/installed", async () => ({
    installedDirectory: getInstalledNodesDirectory(),
    nodes: await loadInstalledNodeManifests()
  }));

  app.post<{ Body: { filename?: string; fileName?: string; manifest?: unknown; text?: string; dataBase64?: string } }>("/api/node-packages/preview", async (request, reply) => {
    try {
      const upload = normalizeNodePackageUpload(request.body);
      if (upload.mode === "archive") {
        const preview = await previewNodePackageArchive(upload.data, { source: upload.filename, existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
        return { ok: true, ...preview };
      }
      if (upload.mode === "unsupported") return reply.code(400).send({ ok: false, issues: [{ path: upload.filename, message: unsupportedNodePackageMessage(upload.filename) }] });
      const manifest = request.body?.manifest ?? parseUploadedNodeManifestJson(upload.text);
      const validation = validateNodeManifest(manifest, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      return validation.ok ? { ok: true, manifest: validation.manifest, warnings: packageWarnings(validation.manifest!) } : validation;
    } catch (error) {
      const filename = request.body?.filename ?? request.body?.fileName ?? "<upload>";
      return reply.code(400).send({ ok: false, issues: [{ path: filename, message: nodePackagePreviewErrorMessage(filename, error) }] });
    }
  });

  app.post<{ Body: { manifest?: unknown; text?: string; dataBase64?: string; filename?: string; fileName?: string; source?: string; files?: Array<{ path: string; dataBase64?: string; text?: string }> } }>("/api/node-packages/install", async (request, reply) => {
    try {
      const upload = normalizeNodePackageUpload(request.body, request.body?.source);
      if (upload.mode === "archive") {
        const installed = await installNodePackageFromArchive(upload.data, { source: request.body.source ?? upload.filename, origin: "installed", overwrite: true });
        return { ok: true, manifest: installed };
      }
      if (upload.mode === "unsupported") return reply.code(400).send({ ok: false, issues: [{ path: upload.filename, message: unsupportedNodePackageMessage(upload.filename) }] });
      const manifest = request.body?.manifest ?? parseUploadedNodeManifestJson(upload.text);
      const duplicateValidation = validateNodeManifest(manifest, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      if (!duplicateValidation.ok) return reply.code(400).send(duplicateValidation);
      const installed = await installNodePackageFromManifest(duplicateValidation.manifest!, {
        source: request.body?.source ?? "local-file",
        files: request.body?.files,
        overwrite: true
      });
      return { ok: true, manifest: installed };
    } catch (error) {
      const filename = request.body?.source ?? request.body?.filename ?? request.body?.fileName ?? "<upload>";
      return reply.code(400).send({ ok: false, issues: [{ path: filename, message: nodePackagePreviewErrorMessage(filename, error) }] });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/node-packages/install-path", async (request, reply) => {
    try {
      const packagePath = request.body?.path?.trim() ?? "";
      if (!packagePath) return reply.code(400).send({ ok: false, error: "path is required." });
      const { installNodePackageFromPath } = await import("@snarkroute/nodes");
      const installed = await installNodePackageFromPath(packagePath, { overwrite: true });
      return { ok: true, manifest: installed };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: { url?: string } }>("/api/node-packages/preview-url", async (request, reply) => {
    try {
      const url = request.body?.url?.trim() ?? "";
      if (!isSupportedRemoteUrl(url)) return reply.code(400).send({ ok: false, error: "URL must be http or https." });
      if (isSnarkNodeArchiveFilename(url)) {
        const preview = await previewNodePackageArchive(await fetchRemoteBytes(url), { source: url, origin: "remote", existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
        return { ok: true, ...preview };
      }
      const json = await fetchRemoteJson(url);
      if ((json as { kind?: string }).kind === "snarkroute.nodeLibrary") {
        const validation = validateNodeLibraryManifest({ ...(json as object), source: url });
        return validation.ok ? { ok: true, library: validation.library } : validation;
      }
      const validation = validateNodeManifest({ ...(json as object), source: url, origin: "remote" }, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      return validation.ok ? { ok: true, manifest: validation.manifest, warnings: packageWarnings(validation.manifest!) } : validation;
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: { url?: string } }>("/api/node-packages/install-url", async (request, reply) => {
    try {
      const url = request.body?.url?.trim() ?? "";
      if (!isSupportedRemoteUrl(url)) return reply.code(400).send({ ok: false, error: "URL must be http or https." });
      if (isSnarkNodeArchiveFilename(url)) {
        const installed = await installNodePackageFromArchive(await fetchRemoteBytes(url), { source: url, origin: "installed", overwrite: true });
        return { ok: true, manifest: installed };
      }
      const json = await fetchRemoteJson(url);
      const validation = validateNodeManifest({ ...(json as object), source: url, origin: "remote" }, { existingIds: allReservedNodeIds(await loadInstalledNodeManifests()) });
      if (!validation.ok || !validation.manifest) return reply.code(400).send(validation);
      const installed = await installNodePackageFromManifest(validation.manifest, { source: url, origin: "installed", overwrite: true });
      return { ok: true, manifest: installed };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Body: { libraryUrl?: string; nodeIds?: string[] } }>("/api/node-packages/install-library", async (request, reply) => {
    try {
      const libraryUrl = request.body?.libraryUrl?.trim() ?? "";
      if (!isSupportedRemoteUrl(libraryUrl)) return reply.code(400).send({ ok: false, error: "Library URL must be http or https." });
      const libraryValidation = validateNodeLibraryManifest({ ...((await fetchRemoteJson(libraryUrl)) as object), source: libraryUrl });
      if (!libraryValidation.ok || !libraryValidation.library) return reply.code(400).send(libraryValidation);
      const selected = new Set(request.body?.nodeIds ?? []);
      const installed: SnarkNodeManifest[] = [];
      for (const entry of libraryValidation.library.nodes.filter((node) => selected.has(node.id))) {
        if (isSnarkNodeArchiveFilename(entry.url)) {
          const manifest = await installNodePackageFromArchive(await fetchRemoteBytes(entry.url), { source: entry.url, origin: "installed", overwrite: true });
          installed.push(manifest);
          continue;
        }
        const json = await fetchRemoteJson(entry.url);
        const validation = validateNodeManifest({ ...(json as object), source: entry.url, origin: "remote" }, { existingIds: allReservedNodeIds([...(await loadInstalledNodeManifests()), ...installed]) });
        if (!validation.ok || !validation.manifest) throw new Error(`Invalid node "${entry.id}": ${formatIssues(validation.issues)}`);
        installed.push(await installNodePackageFromManifest(validation.manifest, { source: entry.url, origin: "installed", overwrite: true }));
      }
      return { ok: true, installed };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/node-packages/:id/enabled", async (request, reply) => {
    try {
      return { ok: true, manifest: await setInstalledNodeEnabled(request.params.id, Boolean(request.body?.enabled)) };
    } catch (error) {
      return reply.code(404).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/node-packages/:id", async (request, reply) => {
    const id = request.params.id;
    const bundled = [...builtInNodeManifests, ...providerNodeManifests()].find((manifest) => manifest.id === id && manifest.origin === "bundled");
    if (bundled) return reply.code(400).send({ ok: false, code: "NODE_PACKAGE_NOT_UNINSTALLABLE", error: `Bundled node "${id}" cannot be deleted.` });
    try {
      await uninstallInstalledNode(id);
      return { ok: true, id, message: `Uninstalled node package "${id}".` };
    } catch (error) {
      const uninstallError = nodePackageUninstallErrorShape(error);
      if (uninstallError) {
        return reply.code(uninstallError.statusCode).send({ ok: false, code: uninstallError.code, error: uninstallError.message });
      }
      return reply.code(500).send({ ok: false, code: "NODE_PACKAGE_DELETE_FAILED", error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/node-packages/:id/readme", async (request, reply) => {
    try {
      const path = join(getInstalledNodesDirectory(), request.params.id.replace(/[^a-z0-9._-]/gi, "_"), "README.md");
      return { ok: true, path, text: await readFile(path, "utf8") };
    } catch (error) {
      return reply.code(404).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get("/api/routes/examples", async () => {
    const files = await listRouteFiles(examplesDirectory);
    return {
      routes: await Promise.all(
        files.map(async (file) => {
          const route = parseRoute(await loadExampleRoute(file));
          return { id: route.route.id, title: route.route.title, description: route.route.description, filename: basename(file), path: file };
        })
      )
    };
  });

  app.get<{ Params: { filename: string } }>("/api/routes/examples/:filename", async (request, reply) => {
    try {
      const file = resolve(examplesDirectory, request.params.filename);
      if (!file.startsWith(resolve(examplesDirectory))) return reply.code(400).send({ error: "Invalid example route path." });
      return await loadExampleRoute(file);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/routes/saved", async () => {
    const files = await listRouteFiles(assetsDirectory);
    return { routes: files.map((file) => ({ filename: basename(file), path: file })) };
  });

  app.get<{ Querystring: { endpoint?: string } }>("/api/local-stable-diffusion/models", async (request, reply) => {
    const endpoint = trimTrailingSlash(request.query.endpoint?.trim() || "http://127.0.0.1:7860");
    try {
      const response = await fetchWithTimeout(`${endpoint}/sdapi/v1/sd-models`, 5000);
      if (response.status === 404) return reply.code(404).send({ error: "Stable Diffusion WebUI API endpoint is not available. Make sure API mode is enabled." });
      const text = await response.text();
      if (!response.ok) return reply.code(response.status).send({ error: `Stable Diffusion WebUI model list failed (${response.status}).` });
      const models = JSON.parse(text) as unknown;
      return { endpoint, models: normalizeStableDiffusionModels(models) };
    } catch (error) {
      return reply.code(400).send({ error: `Local Stable Diffusion server is not reachable at ${endpoint}` });
    }
  });

  app.get("/api/prompt-library", async (request, reply) => {
    try {
      promptLibraryCache = await loadPromptLibrary();
      return summarizePromptLibrary(promptLibraryCache);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error), categories: [] });
    }
  });

  app.get<{ Params: { category: string; id: string } }>("/api/prompt-library/:category/:id", async (request, reply) => {
    try {
      promptLibraryCache = await loadPromptLibrary();
      const prompt = getPromptLibraryPrompt(promptLibraryCache, request.params.category, request.params.id);
      if (!prompt) return reply.code(404).send({ error: `Prompt "${request.params.category}/${request.params.id}" was not found.` });
      return prompt;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/prompt-library/refresh", async (request, reply) => {
    try {
      promptLibraryCache = await loadPromptLibrary();
      return summarizePromptLibrary(promptLibraryCache);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error), categories: [], diagnostics: [{ path: "data/prompt-library", severity: "error", message: errorMessage(error) }] });
    }
  });

  app.patch<{ Params: { category: string; id: string }; Body: UpdatePromptAssetBody }>("/api/prompt-library/:category/:id", async (request, reply) => {
    try {
      const updated = await updatePromptAsset(request.params.category, request.params.id, request.body ?? {});
      promptLibraryCache = await loadPromptLibrary();
      return { ok: true, ...updated, library: summarizePromptLibrary(promptLibraryCache) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { category: string; id: string } }>("/api/prompt-library/:category/:id", async (request, reply) => {
    try {
      const deleted = await deletePromptAsset(request.params.category, request.params.id);
      promptLibraryCache = await loadPromptLibrary();
      return { ok: true, ...deleted, library: summarizePromptLibrary(promptLibraryCache) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: CreatePromptAssetBody }>("/api/prompt-library/generated-image", async (request, reply) => {
    try {
      const saved = await createPromptAssetFromGeneratedImage(request.body ?? {});
      promptLibraryCache = await loadPromptLibrary();
      return { ok: true, ...saved, library: summarizePromptLibrary(promptLibraryCache) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { path?: string; kind?: LocalAssetKind } }>("/api/assets/metadata", async (request, reply) => {
    try {
      return await getLocalAssetMetadata(request.query.path ?? "", request.query.kind ?? "file");
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/assets/preview", async (request, reply) => {
    try {
      const metadata = await getLocalAssetMetadata(request.query.path ?? "", "image");
      reply.header("Content-Type", metadata.mimeType);
      return reply.send(createReadStream(metadata.path));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { kind?: LocalAssetKind } }>("/api/assets/browse", async (request, reply) => {
    try {
      const path = await browseLocalFile(request.body?.kind ?? "file");
      if (!path) return { canceled: true };
      const metadata = await getLocalAssetMetadata(path, request.body?.kind ?? "file");
      return { canceled: false, path: metadata.path, metadata };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { filename?: string; dataBase64?: string; kind?: LocalAssetKind } }>("/api/assets/import", async (request, reply) => {
    try {
      const filename = sanitizeFilename(basename(request.body?.filename ?? "asset.bin"));
      const dataBase64 = request.body?.dataBase64;
      const kind = request.body?.kind ?? "file";
      if (!dataBase64) return reply.code(400).send({ error: "dataBase64 is required." });
      await mkdir(assetsDirectory, { recursive: true });
      const path = join(assetsDirectory, `${Date.now()}-${filename}`);
      await writeFile(path, Buffer.from(dataBase64, "base64"));
      const metadata = await getLocalAssetMetadata(path, kind);
      return { path, metadata };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { model?: string } }>("/api/replicate/schema", async (request, reply) => {
    if (!isReplicateEnabled()) return reply.code(400).send({ error: "REPLICATE_API_TOKEN is not configured.\nOpen Settings \u2192 Secrets \u2192 Replicate and paste your token." });
    if (!request.query.model) return reply.code(400).send({ error: "Query parameter model is required." });
    try {
      return await createReplicateClient().getModelSchema(request.query.model);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/routes/validate", async (request) => {
    const validation = validateRoute(request.body);
    if (!validation.ok || !validation.route) return validation;
    const promptIssues = await validatePromptLibraryNodes(validation.route.nodes);
    const nodeTypeIssues = await validateRouteNodeTypes(validation.route.nodes, [...builtInNodeManifests, ...providerNodeManifests(), ...(await loadInstalledNodeManifests())]);
    const issues = [...promptIssues, ...nodeTypeIssues];
    return {
      ok: issues.length === 0,
      route: issues.length === 0 ? validation.route : undefined,
      issues
    };
  });

  app.post<{ Body: { route?: unknown; initialNodeOutputs?: Record<string, unknown> } }>("/api/routes/run", async (request, reply) => {
    try {
      const routeInput = request.body && typeof request.body === "object" && "routeVersion" in request.body ? request.body : request.body?.route;
      const route = parseRoute(routeInput);
      const executor = createExecutor();
      registerBuiltInNodeRunners(executor);
      await registerInstalledNodeRunners(executor);
      executor.registerNodeRunner("output.text", ({ params, inputs }) => {
        const from = params.from ?? Object.values(inputs)[0] ?? "";
        const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
        return { output: { text } };
      });
      const modelResolver = createModelResolver(await loadOpenRouterMappings());
      executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
      executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner());
      executor.registerNodeRunner("gemini.llm", createGeminiLlmNodeRunner());
      executor.registerNodeRunner("gemini.nano-banana-2", createNanoBanana2NodeRunner());
      executor.registerNodeRunner("ai.text", createRemoteTextNodeRunner(modelResolver));
      executor.registerNodeRunner("ai.image.generate", createRemoteImageNodeRunner(modelResolver));
      const runId = `run_${Date.now()}`;
      const outputDirectory = await storage.createRunDirectory(runId);
      return await executor.executeRoute(route, { runId, outputDirectory, initialNodeOutputs: request.body?.initialNodeOutputs });
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    try {
      return await storage.readRunResult(request.params.runId);
    } catch {
      return reply.code(404).send({ error: `Run "${request.params.runId}" was not found.` });
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/ledger/runs", async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const runs = await readLedgerRuns();
    return { runs: runs.slice(-limit).reverse() };
  });

  app.get<{ Params: { runId: string } }>("/api/ledger/runs/:runId", async (request, reply) => {
    const runs = await readLedgerRuns();
    const run = runs.find((entry) => entry.runId === request.params.runId);
    if (!run) return reply.code(404).send({ error: `Ledger run "${request.params.runId}" was not found.` });
    return run;
  });

  app.get("/api/ledger/summary", async () => summarizeLedgerRuns(await readLedgerRuns()));

  return app;
}

type CreatePromptAssetBody = {
  title?: string;
  slug?: string;
  category?: string;
  description?: string;
  tags?: string[];
  prompt?: string;
  negativePrompt?: string;
  modelHints?: string[];
  source?: {
    runId?: string;
    routeId?: string;
    nodeId?: string;
    outputId?: string;
  };
  imagePath?: string;
  imageDataBase64?: string;
};

type UpdatePromptAssetBody = {
  status?: string;
  category?: string;
};

const promptAssetStatuses = new Set(["draft", "candidate", "approved", "published", "archived"]);

async function updatePromptAsset(category: string, id: string, body: UpdatePromptAssetBody) {
  const prompt = await loadPromptAssetForMutation(category, id);
  const status = cleanSingleLine(body.status);
  const nextCategory = cleanSingleLine(body.category);
  if (!status && !nextCategory) throw new Error("status or category is required.");
  if (status && !promptAssetStatuses.has(status)) throw new Error(`Unsupported prompt status "${status}".`);
  if (nextCategory && !safePathSegment(nextCategory)) throw new Error("Invalid prompt category.");

  const text = await readFile(prompt.path, "utf8");
  const currentCategory = prompt.category;
  const targetCategory = nextCategory || currentCategory;
  const updatedText = updatePromptFrontmatter(text, {
    status: status || prompt.status || "candidate",
    category: targetCategory
  });

  const root = resolve(getPromptLibraryPath());
  const targetDirectory = resolve(root, targetCategory);
  if (!targetDirectory.startsWith(root)) throw new Error("Invalid prompt category.");
  await mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, basename(prompt.path));
  await writeFile(prompt.path, updatedText, "utf8");
  if (targetPath !== prompt.path) {
    if (existsSync(targetPath)) throw new Error(`Prompt asset "${targetCategory}/${id}" already exists.`);
    await rename(prompt.path, targetPath);
    await movePromptPreview(prompt.previewImage, dirname(prompt.path), targetDirectory);
  }
  return { category: targetCategory, id, path: targetPath };
}

async function deletePromptAsset(category: string, id: string) {
  const prompt = await loadPromptAssetForMutation(category, id);
  await rm(prompt.path, { force: true });
  await deletePromptPreview(prompt.previewImage, dirname(prompt.path));
  return { category: prompt.category, id };
}

async function loadPromptAssetForMutation(category: string, id: string) {
  const library = await loadPromptLibrary();
  const prompt = getPromptLibraryPrompt(library, category, id);
  if (!prompt) throw new Error(`Prompt "${category}/${id}" was not found.`);
  const root = resolve(getPromptLibraryPath());
  const promptPath = resolve(prompt.path);
  if (!promptPath.startsWith(root)) throw new Error("Prompt path is outside the prompt library.");
  if (!promptPath.endsWith(".prompt.md")) throw new Error("Only markdown prompt assets can be edited from Studio.");
  return { ...prompt, path: promptPath };
}

function updatePromptFrontmatter(text: string, updates: { status: string; category: string }): string {
  const match = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n)?[\s\S]*)$/u.exec(text);
  if (!match) throw new Error("Prompt file requires YAML frontmatter delimited by ---.");
  let frontmatter = upsertYamlScalarLine(match[2], "category", updates.category);
  frontmatter = upsertYamlScalarLine(frontmatter, "status", updates.status);
  return `${match[1]}${frontmatter}${match[3]}`;
}

function upsertYamlScalarLine(frontmatter: string, key: string, value: string): string {
  const line = `${key}: ${yamlScalar(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}:\\s*.*$`, "m");
  if (pattern.test(frontmatter)) return frontmatter.replace(pattern, line);
  return `${frontmatter.replace(/\s*$/u, "")}\n${line}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function movePromptPreview(previewImage: string | undefined, fromDirectory: string, toDirectory: string): Promise<void> {
  const previewPath = promptPreviewLocalPath(previewImage, fromDirectory);
  if (!previewPath || !existsSync(previewPath)) return;
  const targetPath = join(toDirectory, basename(previewPath));
  if (targetPath === previewPath || existsSync(targetPath)) return;
  await rename(previewPath, targetPath);
}

async function deletePromptPreview(previewImage: string | undefined, promptDirectory: string): Promise<void> {
  const previewPath = promptPreviewLocalPath(previewImage, promptDirectory);
  if (!previewPath) return;
  await rm(previewPath, { force: true });
}

function promptPreviewLocalPath(previewImage: string | undefined, promptDirectory: string): string | null {
  if (!previewImage || /^https?:\/\//i.test(previewImage)) return null;
  const root = resolve(getPromptLibraryPath());
  const previewPath = resolve(promptDirectory, previewImage);
  if (!previewPath.startsWith(root)) return null;
  return previewPath;
}

async function createPromptAssetFromGeneratedImage(body: CreatePromptAssetBody) {
  const title = cleanSingleLine(body.title) || "Generated Image Prompt";
  const category = safePathSegment(body.category || "image-generation") || "image-generation";
  const slug = safePathSegment(body.slug || slugFromTitle(title));
  const prompt = String(body.prompt ?? "").trim();
  if (!slug) throw new Error("Slug is required.");
  if (!prompt) throw new Error("Prompt body is required.");
  if (!body.imagePath && !body.imageDataBase64) throw new Error("imagePath or imageDataBase64 is required.");

  const imageBuffer = body.imageDataBase64
    ? Buffer.from(body.imageDataBase64, "base64")
    : await readPromptAssetImageFromPath(body.imagePath ?? "");
  if (imageBuffer.length <= 0) throw new Error("Prompt asset image is empty.");
  const directory = resolve(getPromptLibraryPath(), category);
  const root = resolve(getPromptLibraryPath());
  if (!directory.startsWith(root)) throw new Error("Invalid prompt library category.");
  await mkdir(directory, { recursive: true });

  const promptPath = join(directory, `${slug}.prompt.md`);
  const previewPath = join(directory, `${slug}.preview.png`);
  if (existsSync(promptPath) || existsSync(previewPath)) {
    throw new Error(`Prompt asset "${category}/${slug}" already exists. Choose a different slug.`);
  }
  const tags = (body.tags ?? []).map(cleanSingleLine).filter(Boolean);
  const modelHints = (body.modelHints ?? []).map(cleanSingleLine).filter(Boolean);
  const source = {
    type: "generated-image",
    runId: cleanSingleLine(body.source?.runId) || undefined,
    routeId: cleanSingleLine(body.source?.routeId) || undefined,
    nodeId: cleanSingleLine(body.source?.nodeId) || undefined,
    outputId: cleanSingleLine(body.source?.outputId) || undefined
  };
  const frontmatter = [
    "---",
    `id: ${yamlScalar(slug)}`,
    `title: ${yamlScalar(title)}`,
    `category: ${yamlScalar(category)}`,
    `description: ${yamlScalar(cleanSingleLine(body.description) || title)}`,
    "kind: system",
    "tags:",
    ...(tags.length ? tags : ["image"]).map((tag) => `- ${yamlScalar(tag)}`),
    `previewImage: ${yamlScalar(`${slug}.preview.png`)}`,
    "status: candidate",
    "source:",
    ...Object.entries(source)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `  ${key}: ${yamlScalar(String(value))}`),
    ...(modelHints.length ? ["modelHints:", ...modelHints.map((hint) => `- ${yamlScalar(hint)}`)] : []),
    ...(String(body.negativePrompt ?? "").trim() ? [`negativePrompt: ${yamlScalar(String(body.negativePrompt ?? "").trim())}`] : []),
    "---",
    "",
    prompt,
    ""
  ].join("\n");
  await writeFile(promptPath, frontmatter, "utf8");
  await writeFile(previewPath, imageBuffer);
  return { promptPath, previewPath, category, slug };
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

async function readPromptAssetImageFromPath(path: string): Promise<Buffer> {
  const imageMetadata = await getLocalAssetMetadata(path, "image");
  if (imageMetadata.sizeBytes <= 0) throw new Error(`Preview image is empty: ${imageMetadata.path}`);
  if (imageMetadata.mimeType !== "image/png") throw new Error("Prompt PNG assets require a PNG image output.");
  return readFile(imageMetadata.path);
}

function writePngTextChunk(buffer: Buffer, key: string, text: string): Buffer {
  assertPng(buffer);
  const chunks: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) throw new Error("Invalid PNG chunk length.");
    const data = buffer.subarray(dataStart, dataEnd);
    const sameKey = (type === "iTXt" && pngTextChunkKey(data) === key) || (type === "tEXt" && pngTextChunkKey(data) === key);
    if (type === "IEND" && !inserted) {
      chunks.push(createITxtChunk(key, text));
      inserted = true;
    }
    if (!sameKey) chunks.push(buffer.subarray(offset, chunkEnd));
    if (type === "IEND") break;
    offset = chunkEnd;
  }
  if (!inserted) throw new Error("PNG file is missing IEND chunk.");
  return Buffer.concat(chunks);
}

function assertPng(buffer: Buffer): void {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Invalid PNG image.");
}

function pngTextChunkKey(data: Buffer): string | null {
  const separator = data.indexOf(0);
  return separator > 0 ? data.toString("latin1", 0, separator) : null;
}

function createITxtChunk(key: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]);
  return createPngChunk("iTXt", payload);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function cleanSingleLine(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safePathSegment(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function slugFromTitle(value: string): string {
  return safePathSegment(value) || `prompt-${Date.now()}`;
}

async function listRouteFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listRouteFiles(path)));
    else if (/\.(orp|route)(\.(json|ya?ml))?$|\.json$|\.ya?ml$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function loadExampleRoute(path: string): Promise<unknown> {
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`Example route was not found: ${path}`);
  const text = await readFile(path, "utf8");
  return loadRouteFromText(text, path);
}

async function refreshPromptLibraryCache(): Promise<void> {
  promptLibraryCache = await loadPromptLibrary();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nodePackageUninstallErrorShape(error: unknown): { code: string; statusCode: number; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.statusCode !== "number" || typeof record.message !== "string") return null;
  return { code: record.code, statusCode: record.statusCode, message: record.message };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStableDiffusionModels(value: unknown): Array<{ title: string; modelName?: string; filename?: string; hash?: string }> {
  if (!Array.isArray(value)) return [];
  const models: Array<{ title: string; modelName?: string; filename?: string; hash?: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title : typeof record.model_name === "string" ? record.model_name : "";
    if (!title.trim()) continue;
    models.push({
      title,
      modelName: typeof record.model_name === "string" ? record.model_name : undefined,
      filename: typeof record.filename === "string" ? record.filename : undefined,
      hash: typeof record.hash === "string" ? record.hash : undefined
    });
  }
  return models;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isReplicateEnabled(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

function isGeminiEnabled(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function isOpenRouterEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

async function openRouterSettingsStatus() {
  const cache = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
  const defaultModel = process.env.OPENROUTER_DEFAULT_MODEL?.trim() || "text.default";
  const models = cache?.models ?? [];
  const resolvedDefault = defaultModel === "text.default" ? "openai/gpt-5.2" : defaultModel;
  return {
    configured: isOpenRouterEnabled(),
    maskedApiKey: isOpenRouterEnabled() ? maskSecret(process.env.OPENROUTER_API_KEY) : "",
    defaultModel,
    budgetWarningUsd: numberEnv("OPENROUTER_BUDGET_WARNING_USD"),
    catalog: {
      refreshedAt: cache?.refreshedAt ?? null,
      modelCount: models.length
    },
    defaultModelStatus: models.length === 0 ? "catalog-empty" : models.some((model) => model.id === resolvedDefault) ? "available" : "not-in-catalog"
  };
}

async function loadOpenRouterMappings(): Promise<ModelMapping[]> {
  const parsed = JSON.parse(await readFile(openRouterMappingsPath, "utf8")) as { models?: unknown };
  return Array.isArray(parsed.models) ? parsed.models.filter((entry): entry is ModelMapping => Boolean(entry && typeof entry === "object" && typeof (entry as ModelMapping).id === "string")) : [];
}

function createRemoteTextNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const openRouterRunner = createOpenRouterTextNodeRunner({ modelResolver });
  const rawOpenRouterRunner = createOpenRouterTextNodeRunner();
  const geminiRunner = createGeminiLlmNodeRunner();
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const requestedModel = stringValue(input.params.model);
    const modelId = !requestedModel || requestedModel === "text.default" ? process.env.OPENROUTER_DEFAULT_MODEL || "text.default" : requestedModel;
    if (modelId.includes("/") && providerMode !== "direct") return rawOpenRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    const resolution = modelResolver({ task: "text", modelId, providerMode });
    if (resolution.provider === "openrouter") return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      return geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
    }
    throw new Error(resolution.provider === "direct" ? "Direct provider is not configured." : "Local provider is not available.");
  };
}

function createRemoteImageNodeRunner(modelResolver: ReturnType<typeof createModelResolver>): NodeRunner {
  const geminiRunner = createNanoBanana2NodeRunner();
  const openRouterRunner = createOpenRouterImageNodeRunner({ modelResolver });
  return async (input) => {
    const providerMode = providerModeParam(input.params.providerMode);
    const modelId = stringValue(input.params.model) || "image.nano-banana";
    const cachedCatalog = await readOpenRouterModelCatalogCache(openRouterCatalogCachePath);
    const cachedModel = cachedCatalog?.models.find((model) => model.id === modelId);
    if (cachedModel && !openRouterModelSupportsImage(cachedModel)) throw new Error("This model is not available for image generation.");
    if (cachedModel && openRouterModelSupportsImage(cachedModel) && providerMode !== "direct") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      const catalogBackedRunner = createOpenRouterImageNodeRunner({
        modelResolver: createModelResolver([catalogImageModelMapping(cachedModel)])
      });
      return catalogBackedRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    const resolution = modelResolver({ task: "image", modelId, providerMode });
    if (resolution.provider === "openrouter") {
      if (!isOpenRouterEnabled()) throw new Error("OpenRouter is selected, but OpenRouter is not configured.");
      return openRouterRunner({ ...input, params: { ...input.params, model: modelId, providerMode } });
    }
    if (resolution.provider === "direct" && resolution.directProvider === "gemini") {
      if (!isGeminiEnabled()) throw new Error("Direct API is selected, but direct provider credentials are missing.");
      const result = await geminiRunner({ ...input, params: { ...input.params, model: resolution.model } });
      const metadata = resolutionMetadata(resolution, {
        requestProvider: resolution.directProvider,
        requestModelSlug: resolution.model,
        estimatedCostStatus: "unknown"
      });
      return {
        ...result,
        output: result.output && typeof result.output === "object" ? { ...(result.output as Record<string, unknown>), metadata, ...metadata } : result.output,
        logs: [...(result.logs ?? []), `Resolved route: ${metadata.resolvedRoute}; fallback: ${metadata.fallbackUsed ? metadata.fallbackReason || "yes" : "no"}`],
        provenance: { ...(result.provenance ?? {}), ...metadata }
      };
    }
    throw new Error(resolution.provider === "direct" ? `Direct API route requires a provider mapping for ${modelId}, but none was found.` : "Local provider is not available.");
  };
}

function catalogImageModelMapping(model: OpenRouterModelInfo): ModelMapping {
  return {
    id: model.id,
    task: "image",
    label: model.name ? `${model.name} (${model.id})` : model.id,
    provider: model.id.split("/")[0] || "openrouter",
    capabilities: ["image-generation"],
    supportsImageGeneration: "supported",
    openrouterModel: model.id,
    directProvider: null,
    directModel: null,
    status: "supported",
    routeSupport: { openrouter: "supported", direct: "unknown" }
  };
}

function openRouterModelSupportsImage(model: OpenRouterModelInfo): boolean {
  if (isOpenRouterRoutingAlias(model.id)) return false;
  const output = model.architecture?.output_modalities ?? [];
  const modality = model.architecture?.modality ?? "";
  return output.includes("image") || modalityOutputModalities(modality).includes("image");
}

function isOpenRouterRoutingAlias(modelId: string): boolean {
  return modelId === "openrouter/auto";
}

function modalityOutputModalities(modality: string): string[] {
  if (!modality) return [];
  const outputSide = modality.includes("->") ? modality.split("->").pop() ?? "" : modality;
  return outputSide.split(/[,+\s/]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
}

function providerModeParam(value: unknown): ProviderMode {
  return value === "openrouter" || value === "direct" || value === "local" ? value : "auto";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function numberEnv(key: string): number | null {
  const number = Number(process.env[key]);
  return Number.isFinite(number) ? number : null;
}

function maskSecret(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.length <= 8 ? "********" : `${trimmed.slice(0, 4)}${"*".repeat(Math.min(16, Math.max(8, trimmed.length - 8)))}${trimmed.slice(-4)}`;
}

function openRouterPublicError(error: unknown): string {
  const message = errorMessage(error);
  if (/missing|not set/i.test(message)) return "OpenRouter API key is not set";
  if (/invalid|401|403/i.test(message)) return "OpenRouter API key seems invalid.";
  if (/not available/i.test(message)) return "Model is not available through OpenRouter.";
  if (/unreachable|fetch failed|network request failed/i.test(message)) return "OpenRouter is unreachable. The API key is configured, but SnarkRoute cannot reach OpenRouter. Check internet access, proxy/VPN/firewall settings, DNS, or OPENROUTER_BASE_URL.";
  return message.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function findExistingDirectory(...parts: string[]): string {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) return join(process.cwd(), ...parts);
    directory = parent;
  }
}

function findExistingFile(...parts: string[]): string {
  let directory = process.cwd();
  while (true) {
    const candidate = join(directory, ...parts);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, "..");
    if (parent === directory) return join(process.cwd(), ...parts);
    directory = parent;
  }
}

function providerNodeManifests(): SnarkNodeManifest[] {
  return [
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "ai.text",
      title: "Text AI",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Text",
      description: "Runs remote text models through OpenRouter by default, with Direct mode in Advanced.",
      enabled: true,
      permissions: { network: true, networkHosts: ["openrouter.ai", "generativelanguage.googleapis.com"], readFiles: false, writeOutputs: false, shell: false, env: ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "ai.text" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "systemPrompt", type: "text", required: false, label: "System" }],
      outputs: [{ id: "text", type: "text", label: "Text" }, { id: "output", type: "json", label: "JSON" }],
      params: [
        { id: "model", type: "text", label: "Model", default: "text.default" },
        { id: "providerMode", type: "text", label: "Provider Mode", default: "auto" },
        { id: "prompt", type: "text", label: "Prompt", default: "" },
        { id: "systemPrompt", type: "text", label: "System Prompt", default: "" }
      ]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "ai.image.generate",
      title: "Image Generation",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Task-based image generation with explicit model selection and transparent connection routing.",
      enabled: true,
      permissions: { network: true, networkHosts: ["openrouter.ai", "generativelanguage.googleapis.com"], readFiles: true, writeOutputs: true, shell: false, env: ["OPENROUTER_API_KEY", "GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "ai.image.generate" },
      inputs: [{ id: "images", type: "image", required: false, label: "Images" }, { id: "prompt", type: "text", required: false, label: "Prompt" }],
      outputs: [{ id: "image", type: "image", label: "Image" }, { id: "output", type: "json", label: "JSON" }],
      params: [
        { id: "model", type: "text", label: "Model", default: "image.nano-banana" },
        { id: "providerMode", type: "text", label: "Connection Route", default: "auto" },
        { id: "prompt", type: "text", label: "Prompt", default: "Create a polished image." },
        { id: "aspectRatio", type: "text", label: "Aspect Ratio", default: "1:1" },
        { id: "imageSize", type: "text", label: "Quality", default: "2K" }
      ]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "replicate.model",
      title: "Replicate Model",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs a Replicate model prediction.",
      enabled: isReplicateEnabled(),
      permissions: { network: true, networkHosts: ["api.replicate.com"], readFiles: true, writeOutputs: false, shell: false, env: ["REPLICATE_API_TOKEN"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "replicate.model" },
      inputs: [{ id: "input", type: "json", required: false, label: "Input" }],
      outputs: [{ id: "output", type: "data", label: "Output" }],
      params: [{ id: "model", type: "text", label: "Model" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "replicate.clarity-upscaler",
      title: "Clarity Upscaler",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs Replicate philz1337x/clarity-upscaler.",
      enabled: isReplicateEnabled(),
      permissions: { network: true, networkHosts: ["api.replicate.com"], readFiles: true, writeOutputs: true, shell: false, env: ["REPLICATE_API_TOKEN"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "replicate.clarity-upscaler" },
      inputs: [{ id: "image", type: "image", required: true, label: "Image" }, { id: "prompt", type: "text", required: false, label: "Prompt" }],
      outputs: [{ id: "image", type: "image", label: "Image" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "gemini.llm",
      title: "Gemini LLM",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Text",
      description: "Runs Gemini text generation.",
      enabled: isGeminiEnabled(),
      permissions: { network: true, networkHosts: ["generativelanguage.googleapis.com"], readFiles: false, writeOutputs: false, shell: false, env: ["GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "gemini.llm" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "systemPrompt", type: "text", required: false, label: "System" }],
      outputs: [{ id: "text", type: "text", label: "Text" }]
    },
    {
      kind: "snarkroute.node",
      schemaVersion: "0.1",
      id: "gemini.nano-banana-2",
      title: "Nano Banana 2",
      version: "0.1.0",
      author: { name: "SnarkRoute maintainers" },
      license: "AGPL-3.0-or-later",
      origin: "bundled",
      source: "snarkroute-core",
      category: "Image Processing",
      description: "Runs Gemini image generation/editing.",
      enabled: isGeminiEnabled(),
      permissions: { network: true, networkHosts: ["generativelanguage.googleapis.com"], readFiles: true, writeOutputs: true, shell: false, env: ["GEMINI_API_KEY"] },
      executor: { type: "builtin", runtime: "builtin", builtinRunner: "gemini.nano-banana-2" },
      inputs: [{ id: "prompt", type: "text", required: false, label: "Prompt" }, { id: "images", type: "image", required: false, label: "Images" }],
      outputs: [{ id: "image", type: "image", label: "Image" }]
    }
  ];
}

function allReservedNodeIds(installed: SnarkNodeManifest[]): string[] {
  return [...builtInNodeManifests, ...providerNodeManifests(), ...installed].map((manifest) => manifest.id);
}

async function fetchRemoteJson(url: string): Promise<unknown> {
  const response = await fetchWithTimeout(url, 15000);
  const text = await response.text();
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  return JSON.parse(text);
}

async function fetchRemoteBytes(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url, 15000);
  if (!response.ok) throw new Error(`Fetch failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function isSnarkNodeArchiveFilename(filename: string): boolean {
  return filename.toLowerCase().split("?")[0].endsWith(".snarknode");
}

type NodePackageUpload =
  | { mode: "archive"; filename: string; data: Buffer }
  | { mode: "json"; filename: string; text: string }
  | { mode: "unsupported"; filename: string };

function normalizeNodePackageUpload(
  body: { filename?: string; fileName?: string; manifest?: unknown; text?: string; dataBase64?: string } | undefined,
  source?: string
): NodePackageUpload {
  const providedFilename = source ?? body?.filename ?? body?.fileName;
  const filename = String(providedFilename ?? "local-file");
  const lower = filename.toLowerCase().split("?")[0];
  if (lower.endsWith(".snarknode")) {
    return { mode: "archive", filename, data: Buffer.from(body?.dataBase64 ?? "", "base64") };
  }
  if (lower.endsWith(".node.json") || lower.endsWith(".json") || (providedFilename === undefined && (body?.manifest !== undefined || body?.text !== undefined))) {
    return { mode: "json", filename, text: uploadedNodeManifestText(body) };
  }
  return { mode: "unsupported", filename };
}

function uploadedNodeManifestText(body: { text?: string; dataBase64?: string } | undefined): string {
  if (typeof body?.text === "string" && body.text.length > 0) return body.text;
  if (body?.dataBase64) return Buffer.from(body.dataBase64, "base64").toString("utf8");
  return "{}";
}

function parseUploadedNodeManifestJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON node manifest.");
  }
}

function nodePackagePreviewErrorMessage(filename: string, error: unknown): string {
  const message = errorMessage(error);
  if (isSnarkNodeArchiveFilename(filename) && isZipFormatError(message)) {
    return "Invalid .snarknode package: expected a ZIP archive. For a plain node manifest, use .node.json.";
  }
  return message;
}

function isZipFormatError(message: string): boolean {
  return /central directory|zip file|corrupted zip|end of data|invalid zip/i.test(message);
}

function unsupportedNodePackageMessage(filename: string): string {
  return `Unsupported node package file type for "${filename}". Use .snarknode for packaged nodes or .node.json for plain node manifests.`;
}

function packageWarnings(manifest: SnarkNodeManifest): string[] {
  const warnings: string[] = [];
  if (manifest.executor.type === "plugin") warnings.push("Contains executable plugin code. Review permissions before installing.");
  if (manifest.permissions.shell) warnings.push("Requests shell permission. This build refuses shell execution.");
  if (manifest.permissions.readFiles) warnings.push("Requests local file read permission.");
  if (manifest.permissions.network) warnings.push(`Requests network access${manifest.permissions.networkHosts?.length ? ` to ${manifest.permissions.networkHosts.join(", ")}` : ""}.`);
  return warnings;
}

async function readLedgerRuns(): Promise<Array<Record<string, unknown>>> {
  let text = "";
  try {
    text = await readFile(getLedgerPath(), "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(stripSecretLikeFields);
}

function summarizeLedgerRuns(runs: Array<Record<string, unknown>>) {
  const runsByProvider: Record<string, number> = {};
  const runsByStatus: Record<string, number> = {};
  let estimatedProviderCostTotal = 0;
  let estimatedCount = 0;
  let actualProviderCostTotal = 0;
  let actualCount = 0;

  for (const run of runs) {
    const status = String(run.status ?? "unknown");
    runsByStatus[status] = (runsByStatus[status] ?? 0) + 1;
    for (const provider of Array.isArray(run.providersUsed) ? run.providersUsed : []) {
      if (provider && typeof provider === "object") {
        const name = String((provider as Record<string, unknown>).provider ?? "unknown");
        runsByProvider[name] = (runsByProvider[name] ?? 0) + 1;
      }
    }
    if (typeof run.estimatedProviderCost === "number") {
      estimatedProviderCostTotal += run.estimatedProviderCost;
      estimatedCount += 1;
    }
    if (typeof run.actualProviderCost === "number") {
      actualProviderCostTotal += run.actualProviderCost;
      actualCount += 1;
    }
  }

  return {
    totalRuns: runs.length,
    runsByProvider,
    runsByStatus,
    estimatedProviderCostTotal: estimatedCount > 0 ? Number(estimatedProviderCostTotal.toFixed(6)) : null,
    actualProviderCostTotal: actualCount > 0 ? Number(actualProviderCostTotal.toFixed(6)) : null,
    paymentExecuted: false,
    paymentExecutedCount: 0,
    recentRuns: runs.slice(-10).reverse()
  };
}

function stripSecretLikeFields(value: unknown): Record<string, unknown> {
  return stripSecrets(value) as Record<string, unknown>;
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/token|secret|password|api[_-]?key/i.test(key))
        .map(([key, entry]) => [key, stripSecrets(entry)])
    );
  }
  return value;
}

async function writeEnvValue(key: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    text = "";
  }

  const escaped = value.replace(/\r?\n/g, "");
  const line = `${key}=${escaped}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.trimEnd()}${text.trimEnd() ? "\n" : ""}${line}\n`;

  await writeFile(envPath, next, "utf8");
}

function browseLocalFile(kind: LocalAssetKind): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Local Browse is currently implemented for Windows in this MVP. Paste an absolute path manually.");
  }
  const filter =
    kind === "image"
      ? "Images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All files (*.*)|*.*"
      : kind === "video"
        ? "Videos (*.mp4;*.mov;*.webm;*.mkv;*.avi)|*.mp4;*.mov;*.webm;*.mkv;*.avi|All files (*.*)|*.*"
        : "All files (*.*)|*.*";
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = '${filter}'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.FileName
}
`;
  return new Promise((resolvePromise, reject) => {
    execFile("powershell", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: false }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
}

if (process.env.SNARKROUTE_NO_LISTEN !== "1") {
  const app = buildServer();
  app.listen({ port, host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}
