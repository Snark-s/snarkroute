import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { createH3RegenerationClient, estimateH3Regeneration, serializeH3RegenerationRequest } from "../packages/adapters/h3/dist/index.js";

export const TEST_ID = "HOSTED-REGEN-MAX-I1-2K";
export const EXPECTED_SOURCE_SHA = "ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9";
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = join(repository, "apps/server/data/h3-hosted-regenerate-eval/2026-09-30");
const sourceDirectory = join(repository, "apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1");
const schemaUrl = "https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration.md";
const pricingUrl = "https://platform.minimax.io/docs/pricing/overview.md";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const timestamp = () => new Date().toISOString();
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

export function probeVideo(path) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,nb_read_packets,duration,bit_rate,sample_rate,channels,channel_layout:format=duration,size,bit_rate,format_name", "-of", "json", path], { encoding: "utf8", timeout: 30_000, windowsHide: true }));
}

export function validateSource(media, sourceSha, byteLength) {
  const video = media.streams?.find((stream) => stream.codec_type === "video");
  const audio = media.streams?.find((stream) => stream.codec_type === "audio");
  const frames = Number(video?.nb_frames);
  const [fpsNumerator, fpsDenominator] = String(video?.avg_frame_rate).split("/").map(Number);
  const area = Number(video?.width) * Number(video?.height);
  const checks = {
    sourceShaMatches: sourceSha === EXPECTED_SOURCE_SHA,
    sourceReadableAndWithinVideoLimit: byteLength > 0 && byteLength <= 50_000_000,
    dimensionsDivisibleBy32: Number.isInteger(video?.width) && Number.isInteger(video?.height) && video.width > 0 && video.height > 0 && video.width % 32 === 0 && video.height % 32 === 0,
    areaInRange: area >= 589_824 && area <= 1_032_192,
    fps24: fpsDenominator > 0 && fpsNumerator === 24 * fpsDenominator,
    exactFrameCount: Number.isInteger(frames) && frames === Number(video?.nb_read_packets),
    frameCountInRange: frames >= 107 && frames <= 362,
    frameCadence17: Number.isInteger(frames) && (frames - 107) % 17 === 0,
    audioStreamExists: Boolean(audio),
    durationInRange: Number(media.format?.duration) >= 4 && Number(media.format?.duration) <= 15,
    mp4Container: String(media.format?.format_name).split(",").includes("mp4"),
  };
  return { passed: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name), video, audio, frameCount: frames, pixelArea: area };
}

export function estimateControlledCost(durationSeconds, imageCount = 1, referenceVideoSeconds = 0) {
  const output = estimateH3Regeneration(durationSeconds, { rateUsdPerSecond: 0.05, markupPercent: 0, markupCredits: 0, source: "https://platform.minimax.io/docs/pricing/overview", effectiveDate: "2026-09-30" });
  const inputMaterialsUsd = Math.max(0, imageCount - 5) * 0.025 + referenceVideoSeconds * 0.05;
  return { output, inputMaterialsUsd, totalEstimatedUsd: Math.round((output.providerUsd + inputMaterialsUsd) * 1e6) / 1e6, actualBillingUsd: null, billingStatus: "estimated / invoice unverified", note: "Container duration used; provider billable duration/rounding may differ. base_video is not an original reference_video; any additional provider charges remain invoice unverified." };
}

export function resolveOriginalConditioning(request, metadata, imageBytes) {
  if (metadata.requestId !== "01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d" || metadata.provider !== "fal" || metadata.model !== "fal/minimax-h3-max") throw new Error("Original source provenance does not match MAX-I1.");
  if (request.body?.prompt_expansion_mode !== "disabled" || metadata.expandedPrompt) throw new Error("Exact final prompt requires further source-conditioning review.");
  if (typeof request.body?.prompt !== "string" || !request.body.prompt.trim()) throw new Error("Original final prompt is missing.");
  if (request.assets?.length !== 1 || request.assets[0].kind !== "image" || request.assets[0].role !== "firstFrame" || !imageBytes.length) throw new Error("Original first-frame conditioning is missing or unexpected.");
  return { prompt: request.body.prompt, references: [{ kind: "image", role: "first_frame", uri: `data:image/jpeg;base64,${Buffer.from(imageBytes).toString("base64")}` }] };
}

export async function reserveSubmission(directory) {
  const handle = await open(join(directory, "submission-lock.json"), "wx");
  try { await handle.writeFile(`${JSON.stringify({ testId: TEST_ID, reservedAt: timestamp(), maximumCreateCalls: 1, doNotRetry: true }, null, 2)}\n`); }
  finally { await handle.close(); }
}

export function redactMedia(value) {
  if (typeof value === "string" && value.startsWith("data:")) return `[inline ${value.slice(5, value.indexOf(";"))}; representation recorded separately]`;
  if (Array.isArray(value)) return value.map(redactMedia);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([name]) => !/authorization|api[_-]?key|token|secret|password/i.test(name)).map(([name, item]) => [name, redactMedia(item)]));
  return value;
}

export async function prepareEvaluation() {
  await mkdir(outputDirectory, { recursive: true });
  try { await readFile(join(outputDirectory, "submission-lock.json")); throw new Error("A submission was already reserved. Refusing to overwrite or repeat this controlled test."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const sourcePath = join(sourceDirectory, "output.mp4");
  const originalRequest = JSON.parse(await readFile(join(sourceDirectory, "request.json"), "utf8"));
  const originalMetadata = JSON.parse(await readFile(join(sourceDirectory, "metadata.json"), "utf8"));
  const sourceBytes = await readFile(sourcePath);
  const imagePath = originalRequest.assets?.[0]?.source;
  if (!imagePath || resolve(imagePath) !== join(repository, "apps/server/data/h3-max-eval/2026-09-27-controlled/inputs/first.jpg")) throw new Error("Unexpected original first-frame source path.");
  const imageBytes = await readFile(imagePath);
  const sourceSha = sha256(sourceBytes);
  const sourceMedia = probeVideo(sourcePath);
  const preflight = validateSource(sourceMedia, sourceSha, sourceBytes.length);
  const conditioning = resolveOriginalConditioning(originalRequest, originalMetadata, imageBytes);
  const input = { ...conditioning, baseVideo: sourceBytes, idempotencyKey: TEST_ID };
  const body = serializeH3RegenerationRequest(input);
  const serialized = JSON.stringify(body);
  const imageMedia = probeVideo(imagePath).streams?.find((stream) => stream.codec_type === "video");
  preflight.checks.originalImageWithinLimits = imageBytes.length <= 30_000_000 && imageMedia?.width >= 256 && imageMedia?.height >= 256 && imageMedia?.width <= 5760 && imageMedia?.height <= 5760;
  preflight.checks.requestWithin64MB = Buffer.byteLength(serialized) <= 64_000_000;
  preflight.passed = Object.values(preflight.checks).every(Boolean);
  preflight.failures = Object.entries(preflight.checks).filter(([, passed]) => !passed).map(([name]) => name);
  // Public schema/pricing reads only. Never calls an inference endpoint during prepare.
  const schemaResponse = await fetch(schemaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!schemaResponse.ok) throw new Error(`Official schema read failed (${schemaResponse.status}).`);
  const schemaText = await schemaResponse.text();
  for (const term of ["VideoRegenerationBaseVideoReq", "base_video", "64 MB", "107", "362", "17", "first_frame", "MiniMax-H3"]) if (!schemaText.includes(term)) throw new Error(`Official schema changed; review required (${term}).`);
  const pricingResponse = await fetch(pricingUrl, { signal: AbortSignal.timeout(30_000) });
  if (!pricingResponse.ok) throw new Error(`Official pricing read failed (${pricingResponse.status}).`);
  const pricingText = await pricingResponse.text();
  if (!/MiniMax-H3-Regeneration[^\n]*\$0\.05/.test(pricingText)) throw new Error("Regeneration pricing changed; review required.");
  const envPath = join(repository, ".env");
  dotenv.config({ path: envPath, override: false });
  const source = { label: "MAX-I1", assetId: `sha256:${sourceSha}`, assetIdKind: "evaluation_content_address_not_new_server_upload", path: sourcePath, sha256: sourceSha, bytes: sourceBytes.length, provider: "fal", model: originalMetadata.model, jobId: originalMetadata.requestId, media: sourceMedia };
  const references = [{ kind: "image", role: "first_frame", path: imagePath, bytes: imageBytes.length, sha256: sha256(imageBytes), dimensions: imageMedia, historicalBytesHashAvailable: false }];
  const now = timestamp();
  const run = { testId: TEST_ID, status: preflight.passed ? "prepared_waiting_for_user_ready" : "blocked_preflight", preparedAt: now, maximumCreateCalls: 1, createCalls: 0, automaticRetry: false, endpoint: "https://api.minimax.io/v2/video_regeneration", model: "MiniMax-H3", sourceMode: "base_video", resolution: "2K", preflight, source, conditioning: { prompt: conditioning.prompt, promptSource: join(sourceDirectory, "request.json"), expansion: "disabled", references, limitation: "Original request records the first-frame path, but no historical image SHA was saved; current bytes are hashed and used without transformation." }, estimate: estimateControlledCost(Number(sourceMedia.format.duration)), environment: { loader: "apps/server/src/services/env-loader.ts:loadRootEnv", envPath, override: false, minimaxKeyConfigured: Boolean(process.env.MINIMAX_API_KEY?.trim()), userReadyRequired: true }, officialSchema: { url: schemaUrl, retrievedAt: now, sha256: sha256(schemaText), reviewedBodyModes: ["source_task_id", "base_video"], requiredBaseVideoFields: ["model", "content", "resolution"], optionalFields: ["callback_url", "aigc_watermark"], promptMaximumCharacters: 40000, originalInputsMustMatch: true, audioRequired: true, fps: 24, dimensionsMultiple: 32, areaRange: [589824,1032192], frameRange: [107,362], cadence: 17, durationApproxSeconds: [4,15], maximumRequestBodyBytesConservative: 64000000, referenceRequirements: "image first/last or reference_image; reference_video and reference_audio only when used originally; original final prompt required" }, pricing: { url: pricingUrl, retrievedAt: now, sha256: sha256(pricingText), outputUsdPerSecond: 0.05, firstFiveImagesFree: true, additionalImageUsd: 0.025, originalReferenceVideoUsdPerSecond: 0.05, originalReferenceAudioUsd: 0 }, timings: {}, capability: { before: "configured_or_not_configured; external_fal_unverified", after: "external_fal_unverified", verificationScope: null }, output: null, actualBilling: { amountUsd: null, status: "invoice_unverified" } };
  const requestRecord = { testId: TEST_ID, method: "POST", endpoint: run.endpoint, body: redactMedia(body), bodyMediaRedacted: true, actualBodySha256: sha256(serialized), actualBodyBytes: Buffer.byteLength(serialized), baseVideoRepresentation: { kind: "existing_client_inline_data_url", mimeType: "video/mp4", sourceAssetId: source.assetId, sourceSha256: sourceSha, encodedCharacters: body.content.find((item) => item.role === "base_video").video_url.url.length }, references, upload: { separateUploadPerformed: false, uploadResult: null, mechanism: "Existing createH3RegenerationClient videoDataUrl; first-frame JPEG inline per official schema" }, authPersisted: false, source_task_id: "not sent; fal job ID is provenance only" };
  await writeJson(join(outputDirectory, "run.json"), run);
  await writeJson(join(outputDirectory, "request.json"), requestRecord);
  await writeJson(join(outputDirectory, "provider-result.json"), { status: "not_submitted", createCalls: 0, responses: [] });
  await writeJson(join(outputDirectory, "metadata.json"), { testId: TEST_ID, status: run.status, source, conditioning: run.conditioning, preflight, estimate: run.estimate, output: null, review: { content: null, motion: null, identity: null, detail: null, temporal: null, audio: null, reason: "No output exists before the authorized submission" } });
  console.log(JSON.stringify({ testId: TEST_ID, status: run.status, preflight: preflight.passed, exactFrames: preflight.frameCount, requestBytes: requestRecord.actualBodyBytes, estimatedUsd: run.estimate.totalEstimatedUsd, actualBilling: "invoice unverified", envPath, keyConfigured: run.environment.minimaxKeyConfigured, createCalls: 0 }, null, 2));
  return { run, input };
}

export async function executeEvaluation(prepared) {
  const { run, input } = prepared;
  if (!run.preflight.passed) throw new Error(`Source incompatible: ${run.preflight.failures.join(", ")}. No POST permitted.`);
  if (!process.env.MINIMAX_API_KEY?.trim()) throw new Error("MINIMAX_API_KEY is missing from the active/root environment. No POST sent.");
  const baseUrl = (process.env.MINIMAX_API_BASE ?? "https://api.minimax.io").replace(/\/$/, "");
  if (baseUrl !== "https://api.minimax.io") throw new Error("This controlled test is pinned to the official global endpoint; alternate base URL requires review.");
  await reserveSubmission(outputDirectory);
  const providerResult = { testId: TEST_ID, createCalls: 0, responses: [] };
  const fetchImpl = async (url, init) => {
    const isCreate = init?.method === "POST";
    if (isCreate && providerResult.createCalls !== 0) throw new Error("Single-submit budget exhausted; refusing retry.");
    if (isCreate) { providerResult.createCalls++; run.createCalls = 1; run.status = "submitting"; run.timings.submissionTime = timestamp(); await writeJson(join(outputDirectory, "run.json"), run); }
    const response = await fetch(url, init);
    if (String(url).startsWith(`${baseUrl}/v2/`)) {
      let raw; try { raw = await response.clone().json(); } catch { raw = { unparsedResponse: (await response.clone().text()).slice(0, 2000) }; }
      providerResult.responses.push({ method: init?.method ?? "GET", endpoint: String(url), receivedAt: timestamp(), httpStatus: response.status, body: redactMedia(raw) });
      if (isCreate && response.ok && (raw.task_id || raw.task?.id)) { run.taskId = raw.task_id ?? raw.task.id; run.timings.providerAcceptedTime = timestamp(); run.status = "accepted"; }
      if (raw.task?.status === "succeeded") run.timings.providerCompletionObservedTime = timestamp();
      await writeJson(join(outputDirectory, "provider-result.json"), providerResult);
      await writeJson(join(outputDirectory, "run.json"), run);
    }
    return response;
  };
  const client = createH3RegenerationClient({ baseUrl, fetchImpl, pollingIntervalMs: 5000, requestTimeoutMs: 60_000, jobTimeoutMs: 60 * 60_000 });
  try {
    const result = await client.run(input);
    run.taskId = result.id; run.resultUrl = result.url;
    run.timings.downloadStartedAt = timestamp();
    const outputBytes = Buffer.from(await client.download(result.url));
    await writeFile(join(outputDirectory, "output.mp4"), outputBytes);
    run.timings.downloadCompletedAt = timestamp();
    const outputMedia = probeVideo(join(outputDirectory, "output.mp4"));
    run.output = { path: join(outputDirectory, "output.mp4"), bytes: outputBytes.length, sha256: sha256(outputBytes), media: outputMedia };
    run.status = "completed_pending_output_review";
    // Render success never promotes broad capability without output/audio/temporal review.
    run.capability.after = "external_fal_render_completed_pending_validation";
  } catch (error) {
    run.status = run.taskId ? "accepted_task_failed_or_unresolved" : providerResult.responses.some((item) => item.method === "POST") ? "submission_rejected" : "submission_transport_outcome_unknown";
    run.error = { message: String(error.message).replaceAll(process.env.MINIMAX_API_KEY, "[redacted]"), automaticRetry: false };
    run.capability.after = "external_fal_unverified";
  }
  run.timings.finishedAt = timestamp();
  if (run.timings.providerAcceptedTime && run.timings.providerCompletionObservedTime) run.timings.generationObservedMs = Date.parse(run.timings.providerCompletionObservedTime) - Date.parse(run.timings.providerAcceptedTime);
  run.timings.endToEndMs = Date.parse(run.timings.finishedAt) - Date.parse(run.timings.submissionTime);
  const finalBody = providerResult.responses.at(-1)?.body;
  run.providerUsage = finalBody?.task?.usage ?? null;
  await writeJson(join(outputDirectory, "run.json"), run);
  await writeJson(join(outputDirectory, "metadata.json"), { ...run, review: { content: null, motion: null, identity: null, detail: null, temporal: null, audio: null, reason: run.output ? "Requires output comparison" : "No regeneration output" } });
  console.log(JSON.stringify({ testId: TEST_ID, status: run.status, createCalls: run.createCalls, taskId: run.taskId ?? null, error: run.error ?? null, output: run.output ? { bytes: run.output.bytes, sha256: run.output.sha256 } : null }, null, 2));
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !["--prepare", "--execute"].includes(process.argv[2])) throw new Error("Use --prepare (no inference API) or --execute (one explicitly authorized submission; never retry).");
  const prepared = await prepareEvaluation();
  if (process.argv[2] === "--execute") await executeEvaluation(prepared);
}
