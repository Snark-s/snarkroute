import cors from "@fastify/cors";
import dotenv from "dotenv";
import Fastify from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { createExecutor } from "@snarkroute/executor";
import { builtInNodeDefinitions, getLocalAssetMetadata, registerBuiltInNodeRunners, type LocalAssetKind } from "@snarkroute/nodes";
import { parseRoute, validateRoute } from "@snarkroute/protocol";
import { createClarityUpscalerNodeRunner, createReplicateClient, createReplicateNodeRunner } from "@snarkroute/replicate";
import { createLocalRunStorage } from "@snarkroute/storage";

dotenv.config();

const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? "127.0.0.1";
const storage = createLocalRunStorage(join(process.cwd(), "data", "runs"));
const envPath = join(process.cwd(), ".env");
const assetsDirectory = join(process.cwd(), "data", "assets");
const getLedgerPath = () => process.env.SNARKROUTE_LEDGER_PATH ?? join(process.cwd(), "data", "ledger", "runs.jsonl");

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 250 * 1024 * 1024 });
  app.register(cors, { origin: true });

  app.get("/api/health", async () => ({ ok: true, app: "snarkroute", replicateEnabled: isReplicateEnabled() }));

  app.get("/api/settings", async () => ({ replicateConfigured: isReplicateEnabled() }));

  app.post<{ Body: { replicateApiToken?: string } }>("/api/settings/replicate-token", async (request, reply) => {
    const token = request.body?.replicateApiToken?.trim();
    if (!token) return reply.code(400).send({ error: "REPLICATE_API_TOKEN cannot be empty." });
    try {
      await writeEnvValue("REPLICATE_API_TOKEN", token);
      process.env.REPLICATE_API_TOKEN = token;
      return { ok: true, replicateConfigured: true };
    } catch (error) {
      return reply.code(500).send({ error: errorMessage(error) });
    }
  });

  app.get("/api/nodes", async () => ({
    nodes: [
      ...builtInNodeDefinitions,
      { type: "replicate.model", title: "Replicate Model", description: "Runs a Replicate model prediction.", enabled: isReplicateEnabled() },
      { type: "replicate.clarity-upscaler", title: "Clarity Upscaler", description: "Runs Replicate philz1337x/clarity-upscaler.", enabled: isReplicateEnabled() }
    ]
  }));

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
    if (!isReplicateEnabled()) return reply.code(400).send({ error: "REPLICATE_API_TOKEN is not configured." });
    if (!request.query.model) return reply.code(400).send({ error: "Query parameter model is required." });
    try {
      return await createReplicateClient().getModelSchema(request.query.model);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/routes/validate", async (request) => validateRoute(request.body));

  app.post("/api/routes/run", async (request, reply) => {
    try {
      const route = parseRoute(request.body);
      const executor = createExecutor();
      registerBuiltInNodeRunners(executor);
      executor.registerNodeRunner("output.text", ({ params, inputs }) => {
        const from = params.from ?? Object.values(inputs)[0] ?? "";
        const text = typeof from === "string" ? from : JSON.stringify(from, null, 2);
        return { output: { text } };
      });
      if (isReplicateEnabled()) {
        executor.registerNodeRunner("replicate.model", createReplicateNodeRunner());
        executor.registerNodeRunner("replicate.clarity-upscaler", createClarityUpscalerNodeRunner());
      }
      const runId = `run_${Date.now()}`;
      const outputDirectory = await storage.createRunDirectory(runId);
      return await executor.executeRoute(route, { runId, outputDirectory });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReplicateEnabled(): boolean {
  return Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
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
