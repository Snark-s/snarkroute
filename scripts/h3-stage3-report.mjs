// Offline evidence aggregation only: never submits provider or worker jobs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function summarizePipeline(source) {
  return {
    id: "PIPELINE-M2K", status: "blocked", localHosted: "hybrid_requested",
    source: { provider: "fal", model: "fal/minimax-h3-max", jobId: source.jobId, outputPath: source.outputPath, sha256: source.sha256, media: source.media },
    requestedFinalization: { provider: "local", model: "h3_base", operation: "regenerate", resolution: "2K", worker: "matlow_int8" },
    reason: "Current MATLOW local worker declares resample unavailable. Existing video_regeneration adapter uses the hosted MiniMax API, not a local Base Regenerate checkpoint.",
    acceptanceTest: "not_run_no_local_regenerate_backend",
    outputPath: null, media: null, timings: null, peakVramGiB: null,
    contentPreservation: null, motionPreservation: null, detailImprovement: null, artifacts: null,
    practicalCost: { hostedSourceListEstimateUsd: 0.4, localFinalizationSeconds: null, note: "Source invoice unverified; original metadata used a stale launch-promotion estimate. No new Max call." },
  };
}

export function summarizeContamination(before, after) {
  return { sequence: ["C0", "C1", "C2", "C0R"], status: before === after ? "passed" : "failed", beforeSha256: before, afterSha256: after, method: "complete MP4 SHA-256 equality", scope: "One fixed-seed local sequence; C2M was completed later and is not covered by this reset comparison." };
}

export async function buildReport(root = resolve(".")) {
  const data = join(root, "apps/server/data");
  const maxDir = join(data, "h3-max-eval/2026-09-27-controlled");
  const turboDir = join(data, "h3-turbo-eval/2026-09-28-controlled");
  const loraDir = join(data, "h3-visual-lora-eval/2026-09-28-controlled");
  const output = join(data, "h3-stage3-eval/2026-09-30");
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const turboPlan = await readJson(join(turboDir, "plan.json"));
  const loraPlan = await readJson(join(loraDir, "plan.json"));
  const runs = [];
  for (const [directory, ids, kind, plan] of [
    [maxDir, ["MAX-T0", "MAX-I1", "MAX-FL1"], "historical_hosted_control", turboPlan],
    [turboDir, ["TURBO-T0", "TURBO-I1", "TURBO-FL1"], "hosted", turboPlan],
    [loraDir, ["C0", "C1", "C2M", "C2", "C0R"], "local", loraPlan],
  ]) {
    for (const id of ids) {
      const folder = join(directory, id);
      const metadataPath = join(folder, "metadata.json");
      const raw = await readJson(metadataPath);
      if (raw.status !== "succeeded") throw new Error(`Incomplete evidence: ${id}`);
      const request = await readJson(join(folder, "request.json"));
      const outputPath = join(folder, "output.mp4");
      const sha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
      const local = kind === "local";
      const worker = raw.workerResult?.metadata;
      const alias = ({ C0: "C0_base", C1: "C1_cinematic", C2M: "C2_motion_strength", C2: "C3_trigger_test", C0R: "C0_reset_control" })[id];
      runs.push({
        id, alias: alias ?? id, status: raw.status, provider: local ? "local" : raw.provider,
        localHosted: kind, model: local ? "h3_base/MATLOW fused Turbo INT8" : raw.model,
        jobId: raw.jobId ?? raw.requestId, endpoint: raw.endpoint ?? "/v1/jobs",
        seed: request.seed ?? request.body?.seed ?? plan.seed,
        prompt: request.prompt ?? request.body?.prompt ?? plan.prompt,
        parameters: request, references: request.references ?? request.assets ?? [],
        modifiers: request.visualModifier ?? null,
        timings: { endToEndMs: local ? raw.latencyMs : raw.latencyMs.totalWithDownload, provider: raw.latencyMs, providerTimings: raw.providerTimings ?? null, worker: worker ?? null },
        cost: local ? { providerChargeUsd: 0, electricityAndHardwareCost: "not_measured" } : { originalRecordedQuote: raw.cost, invoiceVerified: false, currentListEstimateUsd: id.startsWith("MAX") ? 0.4 : 0.2, staleHistoricalQuote: id.startsWith("MAX") },
        vram: local ? { torchReservedPeakGiB: worker.peak_vram_gib, totalGpuPeakGiB: null, note: "Torch reserved memory only; dynamic offload allocations are outside this measurement." } : null,
        startedAt: raw.startedAt, completedAt: raw.completedAt, outputPath, sha256,
        media: raw.media, metadataPath, requestPath: join(folder, "request.json"),
        reviewStripPath: join(folder, "review-strip.jpg"), thumbnailPath: join(folder, "thumbnail.jpg"),
        temporalMetrics: temporalMetrics(outputPath),
      });
    }
  }
  const byId = (id) => runs.find((item) => item.id === id);
  const pipeline = summarizePipeline(byId("MAX-I1"));
  const run = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), experiment: "SnarkRoute H3 stage 3", root,
    status: "completed_with_blocked_local_2k", noAutoRouting: true,
    turboPaidCalls: 3, turboEstimatedTotalUsd: 0.6, invoiceVerified: false, newMaxCalls: 0,
    endpointFidelity: { "MAX-I1": { firstFrameSsim: 0.934199 }, "TURBO-I1": { firstFrameSsim: 0.934203 }, "MAX-FL1": { firstFrameSsim: 0.934100, lastFrameSsim: 0.940506 }, "TURBO-FL1": { firstFrameSsim: 0.933605, lastFrameSsim: 0.939996 }, method: "Previously measured ffmpeg SSIM, input JPEG resized to output 1344x768, first/final decoded frame. Similarity is not perceptual identity scoring." },
    contamination: summarizeContamination(byId("C0").sha256, byId("C0R").sha256),
    visualModifier: { id: "authentic_cinematic_texture", status: "limited", source: "https://civitai.com/models/2890588/minimax-h3-authentic-cinematic-texture", author: "TuTu_1018", version: "v1.0", versionId: 3267949, published: "2026-08-26", filename: "Minimax H3真实电影质感.safetensors", bytes: 309965208, sha256: "51dda79218ea126cbb2e08f3a6d9cc595e2224f4977d7618061954043a8bafcf", mirror: "Alex995647/loras-minimax-h3", revision: "1517498210f571b0ed956f40df2765078daa749d", remoteFilename: "minimax-h3-authentic-cinematic-texture/Minimax H3真实电影质感.safetensors", windowsPath: "C:/Users/serge/AppData/Local/SnarkRoute/models/h3/visual-loras/authentic-cinematic-texture-v1/Minimax H3真实电影质感.safetensors", workerPath: "/home/serge/h3/models/Alex995647/loras-minimax-h3/Minimax H3真实电影质感.safetensors", dtype: "BF16", tensorCount: 516, rank: 16, targetModules: ["adaln_proj.linear", "attn.qkv_proj", "attn.out_proj", "mlp.fc1", "mlp.fc2", "token_refiner"], defaultStrength: 0.7, motionStrength: 0.5, trigger: { description: "DY", structuredTrainedWords: [], conflict: true, requiredByExperiment: false }, license: { type: "Civitai custom permissions, not SPDX", allowNoCredit: true, allowCommercialUse: ["Image", "RentCivit", "Rent"], allowDerivatives: true, allowDifferentLicense: true }, isolatedLoadSeconds: null, isolatedUnloadSeconds: null, faceSwapCombination: "not_tested_rejected_by_current_contract", pictureReferenceStyleTransfer: "remains_failed" },
    limitations: ["One prompt/seed, no statistical model ranking.", "Max controls from a different day; resumed MAX-T0 latency is not a fair generation baseline.", "Audio stream presence/codec checked; no listening or lip-sync verdict.", "Mean luma frame difference measures movement/change, not flicker.", "Hands absent; sampled frames do not establish absence of texture crawling.", "Local timings are affected by offload, encoder caching, swap and worker restarts.", "No isolated LoRA load/unload timing; total GPU peak was not measured.", "FL2VA/Ref2VA with Visual LoRA not GPU-verified.", "C2M had interrupted attempts before successful v2; only completed attempt used in comparisons."],
    comparisonImages: { maxTurbo: join(turboDir, "max-vs-turbo-contact-sheet.jpg"), baseCinematic: join(loraDir, "contact-sheet.jpg"), maxBase2K: null },
    reports: { markdown: join(root, "docs/research/h3-stage3-results-2026-09-30.md"), json: join(output, "run.json"), preview: join(output, "comparison.html") },
    runs: [...runs, pipeline],
  };
  await mkdir(join(output, "PIPELINE-M2K"), { recursive: true });
  await writeFile(join(output, "PIPELINE-M2K/metadata.json"), JSON.stringify(pipeline, null, 2) + "\n");
  await writeFile(join(output, "run.json"), JSON.stringify(run, null, 2) + "\n");
  const url = (path) => relative(output, path).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const cards = (ids) => ids.map((id) => { const item = byId(id); return `<article><h3>${escape(item.alias)}</h3><video controls preload="metadata" poster="${url(item.thumbnailPath)}" src="${url(item.outputPath)}"></video><p>${escape(item.id)} · ${(item.timings.endToEndMs / 1000).toFixed(2)} s end-to-end · ${item.media.video.width}×${item.media.video.height}</p><a href="${url(item.metadataPath)}">Raw metadata</a></article>`; }).join("");
  await writeFile(join(output, "comparison.html"), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>H3 stage 3 — controlled evidence</title><style>body{background:#121821;color:#e5e9ef;font:16px system-ui;max-width:1500px;margin:32px auto;padding:20px}a{color:#81c5ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:20px}article{background:#202a36;padding:18px;border-radius:12px}video,img{width:100%;height:auto}p{line-height:1.5}.warning{border-left:4px solid #efbf60;padding:14px}</style><h1>H3: контролируемые результаты</h1><p>3 Turbo calls ≈ $0.60; 0 new Max calls. One fixed prompt/seed, not a general model ranking.</p><h2>Max vs Turbo</h2><p>Image rows: MAX-T0 / TURBO-T0 / MAX-I1 / TURBO-I1 / MAX-FL1 / TURBO-FL1.</p><img src="${url(run.comparisonImages.maxTurbo)}"><div class="grid">${cards(["MAX-T0", "TURBO-T0", "MAX-I1", "TURBO-I1", "MAX-FL1", "TURBO-FL1"])}</div><h2>Base vs Cinematic LoRA</h2><p>Image rows: C0 Base / C1 0.7 no DY / C2M 0.5 no DY / C2 0.7 DY / C0R Base reset. Same settings except modifier/trigger.</p><img src="${url(run.comparisonImages.baseCinematic)}"><div class="grid">${cards(["C0", "C1", "C2M", "C2", "C0R"])}</div><h2>Max → local Base 2K</h2><p class="warning">BLOCKED: local resample unavailable. No 2K output, no substitute upscale. Selected source below.</p><div class="grid">${cards(["MAX-I1"])}</div><p>Audio: stream structure checked only; listen yourself for room tone, fabric rustle, breath and shutter timing. LoRA: compare facial appearance, hair, tonal contrast and head-turn amplitude. Baseline reset MP4 is byte-identical to C0.</p><a href="run.json">Complete machine-readable evidence and paths</a></html>`);
  return run;
}

function temporalMetrics(path) {
  const diff = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 4e6 });
  const values = [...diff.matchAll(/lavfi.signalstats.YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  if (!values.length) throw new Error(`No temporal measurements: ${path}`);
  const cuts = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", path, "-vf", "select=gt(scene\\,0.3),metadata=print:file=-", "-an", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4e6 });
  return { hardSceneCutsThreshold03: [...cuts.matchAll(/lavfi.scene_score=/g)].length, meanFrameDiffY: values.reduce((sum, value) => sum + value, 0) / values.length, method: "ffmpeg tblend difference + signalstats.YAVG; scene select >0.3. This is not a flicker quality score." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = await buildReport();
  console.log(JSON.stringify({ status: run.status, completedOutputs: run.runs.filter((item) => item.status === "succeeded").length, contamination: run.contamination.status, reports: run.reports }, null, 2));
}
