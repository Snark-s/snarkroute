import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { buildWorkerRequest, escapeHtml, normalizePlan, summarizeRun } from "./h3-ref2va-eval-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const planPath = resolve(args.plan);
const plan = normalizePlan(JSON.parse(await readFile(planPath, "utf8")), planPath);
const outputRoot = resolve(args.output ?? join(dirname(planPath), "run"));
await mkdir(outputRoot, { recursive: true });
const selected = args.only?.length ? plan.tests.filter((test) => args.only.includes(test.id)) : plan.tests;
if (!selected.length) throw new Error("No tests selected.");

const connection = await startLocal(args.server);
const worker = createWorkerClient(connection.workerUrl, connection.serviceToken);
const environment = {
  createdAt: new Date().toISOString(),
  planPath,
  workerUrl: connection.workerUrl,
  capabilities: await worker.json("/v1/capabilities"),
  models: await worker.json("/v1/models"),
};
await writeJson(join(outputRoot, "environment.json"), environment);

if (selected.some((test) => test.identityTransfer?.enabled)) await ensureFaceSwap(worker);

const runItems = [];
for (const test of selected) {
  const directory = join(outputRoot, test.id);
  await mkdir(directory, { recursive: true });
  const existing = await readJson(join(directory, "metadata.json"));
  if (!args.force && existing?.status === "succeeded") {
    runItems.push(existing);
    await writeReport(outputRoot, plan, runItems);
    continue;
  }
  const item = await executeTest(worker, test, directory, planPath);
  runItems.push(item);
  await writeReport(outputRoot, plan, runItems);
}

const summary = summarizeRun(runItems);
await writeJson(join(outputRoot, "run.json"), { ...summary, completedAt: new Date().toISOString(), items: runItems });
await writeReport(outputRoot, plan, runItems);
console.log(JSON.stringify({ outputRoot, report: join(outputRoot, "report.html"), ...summary }, null, 2));
if (summary.failed) process.exitCode = 1;

async function executeTest(worker, test, directory, sourcePlanPath) {
  const startedAt = new Date().toISOString();
  const sourceReferences = [];
  const uploadedUris = [];
  try {
    for (let index = 0; index < test.references.length; index += 1) {
      const reference = test.references[index];
      await access(reference.path);
      const bytes = await readFile(reference.path);
      const mimeType = mimeFor(reference.path);
      const uploaded = await worker.upload(bytes, basename(reference.path), mimeType);
      uploadedUris.push(uploaded.uri);
      const preview = `reference-${index + 1}.jpg`;
      makeThumbnail(reference.path, join(directory, preview));
      sourceReferences.push({
        tag: reference.tag,
        kind: reference.kind,
        purpose: reference.purpose ?? null,
        visualMode: reference.visualMode ?? null,
        sourcePath: reference.path,
        filename: basename(reference.path),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        preview,
      });
    }
    const request = buildWorkerRequest(test, uploadedUris);
    await writeJson(join(directory, "request.json"), request);
    await writeJson(join(directory, "input-metadata.json"), {
      testId: test.id,
      sourcePlanPath,
      prompt: test.prompt,
      contextInstruction: test.contextInstruction,
      finalPrompt: test.finalPrompt,
      referenceOrdering: sourceReferences.map(({ tag, kind, filename, purpose, visualMode }) => ({ tag, kind, filename, purpose, visualMode })),
      references: sourceReferences,
      parameters: {
        modelVariant: test.modelVariant,
        seed: test.seed,
        steps: test.steps,
        durationSeconds: test.durationSeconds,
        aspectRatio: test.aspectRatio,
        scheduler: "simple",
        sampler: "res_multistep",
        guidance: "basic/no CFG scale",
        flowParameters: { shiftVideo: 12, shiftAudio: 3 },
        identityTransfer: test.identityTransfer ?? null,
      },
    });
    const manifestHash = createHash("sha256").update(JSON.stringify({ id: test.id, request, sourceReferences })).digest("hex").slice(0, 20);
    let job = await worker.json("/v1/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": `ref2va-eval:${test.id}:${manifestHash}` },
      body: JSON.stringify(request),
    });
    const jobId = job.id;
    const timeoutAt = Date.now() + 2 * 60 * 60_000;
    let lastStage = "";
    while (!["succeeded", "completed", "failed", "cancelled"].includes(job.status)) {
      if (Date.now() > timeoutAt) throw new Error(`${test.id}: worker job ${jobId} timed out.`);
      if (job.stage !== lastStage) {
        console.log(`[${test.id}] ${job.status} ${job.stage ?? ""} ${Math.round((job.progress ?? 0) * 100)}%`);
        lastStage = job.stage;
      }
      await delay(5_000);
      job = await worker.json(`/v1/jobs/${encodeURIComponent(jobId)}`);
    }
    if (!['succeeded', 'completed'].includes(job.status)) {
      throw new Error(typeof job.error === "string" ? job.error : job.error?.message ?? `${test.id}: ${job.status}`);
    }
    const result = await worker.json(`/v1/jobs/${encodeURIComponent(jobId)}/result`);
    const video = await worker.bytes(`/v1/jobs/${encodeURIComponent(jobId)}/content?variant=0`, { headers: { Accept: "video/mp4" } });
    if (video.length < 12 || video.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error(`${test.id}: invalid MP4 output.`);
    await writeFile(join(directory, "output.mp4"), video);
    makeThumbnail(join(directory, "output.mp4"), join(directory, "thumbnail.jpg"));
    const metadata = {
      id: test.id,
      status: "succeeded",
      jobId,
      startedAt,
      completedAt: new Date().toISOString(),
      outputPath: join(directory, "output.mp4"),
      outputBytes: video.length,
      references: sourceReferences,
      metadata: result.metadata,
      observationPrompts: test.observationPrompts ?? [],
    };
    await writeJson(join(directory, "metadata.json"), metadata);
    return metadata;
  } catch (error) {
    const metadata = {
      id: test.id,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      references: sourceReferences,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJson(join(directory, "metadata.json"), metadata);
    console.error(`[${test.id}] ${metadata.error}`);
    return metadata;
  }
}

async function startLocal(serverUrl) {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/h3/local/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Could not start local H3: ${body.error ?? response.status}`);
  const serviceToken = process.env.H3_WORKER_SERVICE_TOKEN ?? await envValue(resolve(".env"), "H3_WORKER_SERVICE_TOKEN");
  if (!serviceToken) throw new Error("Local H3 started, but H3_WORKER_SERVICE_TOKEN is unavailable.");
  return { workerUrl: body.status.workerUrl, serviceToken };
}

function createWorkerClient(baseUrl, token) {
  async function request(path, init = {}) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(init.timeout ?? 180_000),
    });
    if (!response.ok) throw new Error(`Worker ${path} failed (${response.status}): ${(await response.text()).slice(0, 2000)}`);
    return response;
  }
  return {
    async json(path, init) { return (await request(path, init)).json(); },
    async bytes(path, init) { return Buffer.from(await (await request(path, init)).arrayBuffer()); },
    async upload(bytes, filename, mimeType) {
      return (await request("/v1/assets", {
        method: "POST",
        headers: { "Content-Type": mimeType, "X-Filename": encodeURIComponent(filename) },
        body: bytes,
        timeout: 10 * 60_000,
      })).json();
    },
  };
}

async function ensureFaceSwap(worker) {
  let state = await worker.json("/v1/models");
  let modifier = state.modifiers?.find((entry) => entry.id === "faceswap_ref2va");
  if (modifier?.weights_installed) return;
  await worker.json("/v1/models/faceswap_ref2va/download", { method: "POST", body: "{}" });
  const timeoutAt = Date.now() + 20 * 60_000;
  while (Date.now() < timeoutAt) {
    await delay(3_000);
    state = await worker.json("/v1/models");
    modifier = state.modifiers?.find((entry) => entry.id === "faceswap_ref2va");
    if (modifier?.weights_installed) return;
    if (modifier?.status === "failed") throw new Error(`FaceSwap download failed: ${modifier.error}`);
  }
  throw new Error("FaceSwap download timed out.");
}

async function writeReport(root, planValue, items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const cards = planValue.tests.map((test) => {
    const item = byId.get(test.id);
    const status = item?.status ?? "pending";
    const metadata = item?.metadata ?? {};
    const refs = (item?.references ?? test.references).map((reference, index) => {
      const preview = item ? `${test.id}/${reference.preview}` : "";
      return `<figure>${preview ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(reference.tag)}">` : ""}<figcaption>${escapeHtml(reference.tag ?? `Reference ${index + 1}`)} · ${escapeHtml(reference.purpose ?? "unspecified")}</figcaption></figure>`;
    }).join("");
    return `<article class="card ${escapeHtml(status)}"><h2>${escapeHtml(test.id)} <span>${escapeHtml(status)}</span></h2>
      <p><strong>Variable:</strong> ${escapeHtml(test.variable ?? "control")}</p>
      <video controls preload="metadata" poster="${escapeHtml(test.id)}/thumbnail.jpg" src="${escapeHtml(test.id)}/output.mp4"></video>
      <div class="refs">${refs}</div>
      ${test.assessment ? `<p class="assessment"><strong>Assessment:</strong> ${escapeHtml(test.assessment)}</p>` : ""}
      <details><summary>Request & metadata</summary><pre>${escapeHtml(JSON.stringify({ seed: test.seed, steps: test.steps, prompt: test.prompt, contextInstruction: test.contextInstruction, worker: metadata, error: item?.error }, null, 2))}</pre></details>
      <p>${(test.observationPrompts ?? []).map(escapeHtml).join(" · ")}</p></article>`;
  }).join("\n");
  const summary = summarizeRun(items);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>H3 Ref2VA capability evaluation</title><style>
    :root{color-scheme:dark;background:#0b0f14;color:#e8edf3;font:15px system-ui}body{margin:24px}header{position:sticky;top:0;background:#0b0f14e8;padding:12px 0;z-index:2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px}.card{border:1px solid #34404d;border-radius:12px;padding:14px;background:#111821}.card.failed{border-color:#b45050}.card.succeeded{border-color:#3f7d5a}h2{margin:0 0 8px}h2 span{font-size:12px;color:#9aacbd}video{width:100%;background:#050608;aspect-ratio:16/9}.refs{display:flex;gap:8px;overflow:auto;margin:10px 0}.refs figure{margin:0;min-width:150px}.refs img{width:150px;height:96px;object-fit:cover;border-radius:6px}.refs figcaption{font-size:11px;color:#aeb9c5}.assessment{padding:10px;border-left:3px solid #d69a50;background:#181c22}pre{white-space:pre-wrap;font-size:11px;max-height:360px;overflow:auto}</style></head><body>
    <header><h1>H3 Ref2VA capability evaluation</h1><p>${summary.succeeded}/${summary.total} succeeded · ${summary.failed} failed · ${summary.pending} pending</p></header><main class="grid">${cards}</main></body></html>`;
  await writeFile(join(root, "report.html"), html, "utf8");
}

function makeThumbnail(input, output) {
  const video = [".mp4", ".mov", ".webm"].includes(extname(input).toLowerCase());
  const command = [...(video ? ["-ss", "1"] : []), "-i", input, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", output];
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", ...command], { encoding: "utf8" });
  if (result.status !== 0) console.warn(`Thumbnail failed for ${input}: ${result.stderr.trim()}`);
}

function mimeFor(path) {
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg" })[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function parseArgs(argv) {
  const parsed = { server: "http://127.0.0.1:4317", only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") parsed.output = argv[++index];
    else if (value === "--server") parsed.server = argv[++index];
    else if (value === "--only") parsed.only = argv[++index].split(",").map((item) => item.trim()).filter(Boolean);
    else if (value === "--force") parsed.force = true;
    else if (!parsed.plan) parsed.plan = value;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!parsed.plan) throw new Error("Usage: node scripts/h3-ref2va-eval.mjs <plan.json> [--output dir] [--only A0,S1] [--force]");
  return parsed;
}

async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function envValue(path, key) {
  const text = await readFile(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match?.[1] !== key) continue;
    return match[2].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return "";
}
function delay(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }
