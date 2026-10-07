import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createH3HostedClient, estimateH3HostedCost, serializeH3HostedRequest } from "../packages/adapters/h3/dist/index.js";

const root = resolve(process.argv[2] || "apps/server/data/h3-turbo-eval/2026-09-28-controlled");
const maxRoot = resolve("apps/server/data/h3-max-eval/2026-09-27-controlled");
const inputDir = join(maxRoot, "inputs");
const [first, last] = await Promise.all([readFile(join(inputDir, "first.jpg")), readFile(join(inputDir, "last.jpg"))]);
const image = (bytes) => `data:image/jpeg;base64,${bytes.toString("base64")}`;
const prompt = "A photorealistic studio portrait of the same woman in a black blouse. She begins in left profile, pauses, then turns her head smoothly toward the lens and settles into direct eye contact. The camera performs one slow, steady push-in from a medium close-up to a tighter close-up; no cuts, no reframing jumps. Soft neutral key light remains stable while a subtle warm rim light grows along her hair. End state: she faces the camera squarely, completely still, with a calm focused expression. Natural synchronized sound: quiet studio room tone, a soft fabric rustle during the turn, one gentle breath, and a single camera-shutter click exactly after she becomes still. No dialogue, no music, no subtitles.";
const seed = 5242017;
const cases = [
  { id: "TURBO-T0", purpose: "text-only controlled match", references: [] },
  { id: "TURBO-I1", purpose: "first-frame controlled match", references: [{ kind: "image", role: "firstFrame", uri: image(first), source: join(inputDir, "first.jpg") }] },
  { id: "TURBO-FL1", purpose: "first-plus-last controlled match", references: [{ kind: "image", role: "firstFrame", uri: image(first), source: join(inputDir, "first.jpg") }, { kind: "image", role: "lastFrame", uri: image(last), source: join(inputDir, "last.jpg") }] },
];

if (!process.env.FAL_KEY?.trim()) throw new Error("FAL_KEY is not configured in this process.");
await mkdir(root, { recursive: true });
const plan = { createdAt: new Date().toISOString(), provider: "fal", model: "fal/minimax-h3-max-turbo", resolution: "768P", duration: 5, seed, promptExpansionMode: "disabled", prompt, maxPaidCalls: 3, cases: cases.map(({ id, purpose, references }) => ({ id, purpose, references: references.map(({ kind, role, source }) => ({ kind, role, source })) })) };
await writeJson(join(root, "plan.json"), plan);
const client = createH3HostedClient({ pollingIntervalMs: 2_000, timeoutMs: 30 * 60_000 });
const results = [];
// Persist the experiment-wide ceiling across restarts, including uncertain submissions.
let paidCalls = 0;
for (const test of cases) {
  const directory = join(root, test.id);
  if (await readJsonIfExists(join(directory, "submission.json")) || await readJsonIfExists(join(directory, "metadata.json"))) paidCalls += 1;
}

for (const test of cases) {
  const directory = join(root, test.id);
  await mkdir(directory, { recursive: true });
  const previous = await readJsonIfExists(join(directory, "metadata.json"));
  if (previous?.status === "succeeded" || previous?.status === "failed") {
    results.push(previous);
    process.stdout.write(`${test.id}: existing terminal record; no resubmit\n`);
    if (previous?.error?.code === "insufficient_credits") break;
    continue;
  }
  if (await readJsonIfExists(join(directory, "submission.json"))) throw new Error(`${test.id}: prior submission reserved; reconcile the provider request before any further paid call.`);
  if (paidCalls >= 3) throw new Error("Controlled-call ceiling reached.");
  const input = { prompt, duration: 5, modelVariant: "h3_max_turbo", resolution: "768P", promptExpansionMode: "disabled", seed, variants: 1, aspectRatio: "16:9", references: test.references.map(({ source: _source, ...reference }) => reference) };
  const request = serializeH3HostedRequest(input);
  const quote = estimateH3HostedCost({ variant: "h3_max_turbo", duration: 5, resolution: "768P", endpoint: request.endpoint, now: new Date() });
  process.stdout.write(`${test.id}: quote $${quote.amountUsd.toFixed(2)} (${quote.rateUsdPerSecond.toFixed(2)}/s × 5s), then submit ${request.endpoint}\n`);
  await writeJson(join(directory, "request.json"), { endpoint: request.endpoint, body: redactDataUris(request.body), warnings: request.warnings, provenance: request.provenance, quote, assets: test.references.map(({ kind, role, source }) => ({ kind, role, source })) });
  const timeline = [{ event: "price_quoted", at: new Date().toISOString(), amountUsd: quote.amountUsd }];
  const startedAt = new Date();
  let requestId;
  paidCalls += 1;
  await writeJson(join(directory, "submission.json"), { status: "reserved_before_submit", startedAt: startedAt.toISOString(), endpoint: request.endpoint, quote, note: "Never resubmit an uncertain attempt automatically." });
  try {
    timeline.push({ event: "submit_started", at: new Date().toISOString() });
    const result = await client.run(request, undefined, {
      onSubmitted: (id) => { requestId = id; timeline.push({ event: "accepted", at: new Date().toISOString(), requestId: id }); process.stdout.write(`${test.id}: accepted ${id}\n`); },
      onStatus: (status) => { const value = String(status.status || "queued").toLowerCase(); timeline.push({ event: `provider_${value}`, at: new Date().toISOString() }); process.stdout.write(`${test.id}: ${value}\n`); },
    });
    timeline.push({ event: "provider_complete", at: new Date().toISOString() });
    const downloadStarted = Date.now();
    const outputPath = join(directory, "output.mp4");
    await writeFile(outputPath, Buffer.from(await client.download(result.video.url)));
    const downloadMs = Date.now() - downloadStarted;
    timeline.push({ event: "local_ready", at: new Date().toISOString(), outputPath });
    const media = probe(outputPath);
    createReviewAssets(outputPath, directory);
    const metadata = { status: "succeeded", id: test.id, purpose: test.purpose, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), requestId: result.requestId, endpoint: result.endpoint, provider: "fal", model: "fal/minimax-h3-max-turbo", upstream: "MiniMaxAI/MiniMax-H3", outputPath, expandedPrompt: result.expanded_prompt, seed: result.seed, providerTimings: result.timings, latencyMs: { ...result.latency, download: downloadMs, totalWithDownload: result.latency.totalMs + downloadMs }, cost: quote, media, timeline };
    await writeJson(join(directory, "metadata.json"), metadata);
    await writeJson(join(directory, "provider-result.json"), { normalized: { requestId: result.requestId, endpoint: result.endpoint, video: { ...result.video, url: "[provider URL omitted from report]" }, expandedPrompt: result.expanded_prompt, seed: result.seed, timings: result.timings } });
    results.push(metadata);
    process.stdout.write(`${test.id}: local ready in ${(metadata.latencyMs.totalWithDownload / 1000).toFixed(1)}s\n`);
  } catch (error) {
    const normalized = error instanceof Error ? { name: error.name, message: error.message, code: error.code, status: error.status, retryable: error.retryable, details: error.details } : { message: String(error) };
    timeline.push({ event: "failed", at: new Date().toISOString(), code: normalized.code });
    const metadata = { status: "failed", id: test.id, purpose: test.purpose, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), requestId, cost: quote, error: normalized, timeline };
    await writeJson(join(directory, "metadata.json"), metadata);
    results.push(metadata);
    process.stdout.write(`${test.id}: FAILED ${normalized.code || "unknown"}: ${normalized.message}\n`);
    if (normalized.code === "insufficient_credits") break;
  }
}

await writeJson(join(root, "run.json"), { ...plan, completedAt: new Date().toISOString(), paidCalls, results });

function redactDataUris(body) { return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, typeof value === "string" && value.startsWith("data:") ? `[data URI ${value.slice(5, value.indexOf(";"))}]` : value])); }
function probe(path) { const raw = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" })); const video = raw.streams.find((stream) => stream.codec_type === "video"); const audio = raw.streams.find((stream) => stream.codec_type === "audio"); return { durationSeconds: Number(raw.format?.duration || 0), sizeBytes: Number(raw.format?.size || 0), video: { codec: video?.codec_name, width: video?.width, height: video?.height, frameRate: video?.avg_frame_rate }, audio: audio ? { present: true, codec: audio.codec_name, channels: audio.channels, sampleRate: Number(audio.sample_rate), durationSeconds: Number(audio.duration || raw.format?.duration || 0) } : { present: false } }; }
function createReviewAssets(path, directory) { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", path, "-frames:v", "1", join(directory, "thumbnail.jpg")]); execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vf", "fps=1,tile=5x1", "-frames:v", "1", join(directory, "review-strip.jpg")]); }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readJsonIfExists(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
