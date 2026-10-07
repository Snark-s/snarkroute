import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createH3HostedClient, estimateH3HostedCost, serializeH3HostedRequest } from "../packages/adapters/h3/dist/index.js";

const root = resolve(process.argv[2] || "apps/server/data/h3-max-eval/2026-09-27-controlled");
const inputDir = join(root, "inputs");
const firstPath = join(inputDir, "first.jpg");
const lastPath = join(inputDir, "last.jpg");
const videoPath = join(inputDir, "base-reference.mp4");
const productionPrompt = `A photorealistic studio portrait of the same woman in a black blouse. She begins in left profile, pauses, then turns her head smoothly toward the lens and settles into direct eye contact. The camera performs one slow, steady push-in from a medium close-up to a tighter close-up; no cuts, no reframing jumps. Soft neutral key light remains stable while a subtle warm rim light grows along her hair. End state: she faces the camera squarely, completely still, with a calm focused expression. Natural synchronized sound: quiet studio room tone, a soft fabric rustle during the turn, one gentle breath, and a single camera-shutter click exactly after she becomes still. No dialogue, no music, no subtitles.`;
const seed = 5242017;
const resumeIds = process.env.H3_MAX_RESUME_IDS ? JSON.parse(process.env.H3_MAX_RESUME_IDS) : {};

await mkdir(root, { recursive: true });
const [first, last, baseVideo] = await Promise.all([readFile(firstPath), readFile(lastPath), readFile(videoPath)]);
const image = (bytes) => `data:image/jpeg;base64,${bytes.toString("base64")}`;
const video = (bytes) => `data:video/mp4;base64,${bytes.toString("base64")}`;

const cases = [
  { id: "MAX-T0", purpose: "text-only production prompt", references: [] },
  { id: "MAX-I1", purpose: "first-frame image-to-video", references: [{ kind: "image", role: "firstFrame", uri: image(first), source: firstPath }] },
  { id: "MAX-FL1", purpose: "first-plus-last keyframes", references: [{ kind: "image", role: "firstFrame", uri: image(first), source: firstPath }, { kind: "image", role: "lastFrame", uri: image(last), source: lastPath }] },
  { id: "MAX-V1", purpose: "semantic video motion/identity reference", prompt: `Video 1 supplies the woman's identity, studio, head-turn motion, timing, framing, and camera continuity. Recreate that performance while following this production direction: ${productionPrompt}`, references: [{ kind: "video", role: "reference", uri: video(baseVideo), source: videoPath }] },
  { id: "MAX-MR1", purpose: "two-image semantic appearance sanity", prompt: `Image 1 and Image 2 show the same woman and define her identity, hair, black blouse, and neutral studio appearance. Keep her consistent while following this production direction: ${productionPrompt}`, references: [{ kind: "image", role: "reference", uri: image(first), source: firstPath }, { kind: "image", role: "reference", uri: image(last), source: lastPath }] },
  { id: "MAX-A1", purpose: "native dialogue, Foley, ambience, and lip-sync audit", prompt: `Use the first frame exactly for the same woman, black blouse, and neutral photo studio. She turns smoothly from left profile toward the lens. As her face reaches a three-quarter angle she says clearly in English, "Ready. Rolling." with natural precise lip synchronization. She then faces the lens, becomes still, takes one soft breath, and a single camera-shutter click sounds at the end. Quiet stereo studio room tone and one subtle fabric rustle; no music, no subtitles. One continuous slow camera push-in, no cuts.`, references: [{ kind: "image", role: "firstFrame", uri: image(first), source: firstPath }] }
];

const plan = {
  createdAt: new Date().toISOString(),
  provider: "fal",
  model: "fal/minimax-h3-max",
  resolution: "768P",
  duration: 5,
  seed,
  promptExpansionMode: "disabled",
  productionPrompt,
  cases: cases.map(({ id, purpose, references }) => ({ id, purpose, references: references.map((reference) => ({ kind: reference.kind, role: reference.role, source: reference.source })) }))
};
await writeJson(join(root, "plan.json"), plan);

if (!process.env.FAL_KEY?.trim()) throw new Error("FAL_KEY is not configured in this process.");
const client = createH3HostedClient({ pollingIntervalMs: 2_000, timeoutMs: 30 * 60_000 });
const summary = [];
for (const test of cases) {
  const directory = join(root, test.id);
  await mkdir(directory, { recursive: true });
  const previous = await readJsonIfExists(join(directory, "metadata.json"));
  if (previous?.status === "succeeded") { summary.push(previous); process.stdout.write(`${test.id}: already complete, skipping\n`); continue; }
  if (previous?.status === "failed" && previous?.error?.code === "insufficient_credits") { summary.push(previous); process.stdout.write(`${test.id}: blocked by exhausted balance, not resubmitting\n`); continue; }
  const input = { prompt: test.prompt || productionPrompt, duration: 5, modelVariant: "h3_max", resolution: "768P", promptExpansionMode: "disabled", seed, variants: 1, aspectRatio: "16:9", references: test.references.map(({ source: _source, ...reference }) => reference) };
  const request = serializeH3HostedRequest(input);
  const requestRecord = { endpoint: request.endpoint, body: redactDataUris(request.body), warnings: request.warnings, provenance: request.provenance, assets: test.references.map(({ kind, role, source }) => ({ kind, role, source })) };
  await writeJson(join(directory, "request.json"), requestRecord);
  const startedAt = new Date();
  let acceptedRequestId = resumeIds[test.id];
  process.stdout.write(`${test.id}: ${acceptedRequestId ? `resume ${acceptedRequestId}` : `submit ${request.endpoint}`}\n`);
  try {
    const result = acceptedRequestId ? await client.resume(request, acceptedRequestId, undefined, {
      onStatus: (status) => process.stdout.write(`${test.id}: ${String(status.status || "queued").toLowerCase()}\n`)
    }) : await client.run(request, undefined, {
      onSubmitted: (requestId) => { acceptedRequestId = requestId; process.stdout.write(`${test.id}: accepted ${requestId}\n`); },
      onStatus: (status) => process.stdout.write(`${test.id}: ${String(status.status || "queued").toLowerCase()}\n`)
    });
    const downloadStarted = Date.now();
    const outputPath = join(directory, "output.mp4");
    await writeFile(outputPath, Buffer.from(await client.download(result.video.url)));
    const downloadMs = Date.now() - downloadStarted;
    const media = probe(outputPath);
    createReviewAssets(outputPath, directory);
    const quote = estimateH3HostedCost({ variant: "h3_max", duration: 5, resolution: "768P", endpoint: request.endpoint, now: startedAt });
    const metadata = {
      status: "succeeded",
      id: test.id,
      purpose: test.purpose,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      requestId: result.requestId,
      endpoint: result.endpoint,
      provider: "fal",
      model: "fal/minimax-h3-max",
      upstream: "MiniMaxAI/MiniMax-H3",
      outputPath,
      expandedPrompt: result.expanded_prompt,
      seed: result.seed,
      providerTimings: result.timings,
      latencyMs: { ...result.latency, download: downloadMs, totalWithDownload: result.latency.totalMs + downloadMs },
      cost: { ...quote, referenceInputChargeUsd: test.id === "MAX-V1" ? "provider-token-metered; estimate separately" : 0 },
      media
    };
    await writeJson(join(directory, "metadata.json"), metadata);
    await writeJson(join(directory, "provider-result.json"), { ...result.raw, data: undefined, normalized: { requestId: result.requestId, endpoint: result.endpoint, video: { ...result.video, url: "[provider URL omitted from report]" }, expandedPrompt: result.expanded_prompt, seed: result.seed, timings: result.timings } });
    summary.push(metadata);
    process.stdout.write(`${test.id}: complete ${(metadata.latencyMs.totalWithDownload / 1000).toFixed(1)}s, audio=${media.audio.present}\n`);
  } catch (error) {
    const metadata = { status: "failed", id: test.id, purpose: test.purpose, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), requestId: acceptedRequestId, error: error instanceof Error ? { name: error.name, message: error.message, code: error.code, status: error.status, retryable: error.retryable, details: error.details } : String(error) };
    await writeJson(join(directory, "metadata.json"), metadata);
    summary.push(metadata);
    process.stdout.write(`${test.id}: FAILED ${metadata.error.message || metadata.error}\n`);
    continue;
  }
}
await writeJson(join(root, "run.json"), { ...plan, completedAt: new Date().toISOString(), results: summary });

function redactDataUris(body) {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? value.map(redactValue) : redactValue(value)]));
}
function redactValue(value) { return typeof value === "string" && value.startsWith("data:") ? `[data URI ${value.slice(5, value.indexOf(";"))}]` : value; }
function probe(path) {
  const raw = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" }));
  const videoStream = raw.streams.find((stream) => stream.codec_type === "video");
  const audioStream = raw.streams.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds: Number(raw.format?.duration || 0),
    sizeBytes: Number(raw.format?.size || 0),
    video: { codec: videoStream?.codec_name, width: videoStream?.width, height: videoStream?.height, frameRate: videoStream?.avg_frame_rate },
    audio: audioStream ? { present: true, codec: audioStream.codec_name, channels: audioStream.channels, channelLayout: audioStream.channel_layout, sampleRate: Number(audioStream.sample_rate), durationSeconds: Number(audioStream.duration || raw.format?.duration || 0) } : { present: false }
  };
}
function createReviewAssets(path, directory) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", path, "-frames:v", "1", join(directory, "thumbnail.jpg")]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vf", "fps=1,tile=5x1", "-frames:v", "1", join(directory, "review-strip.jpg")]);
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readJsonIfExists(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
