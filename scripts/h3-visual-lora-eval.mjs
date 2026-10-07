import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createH3WorkerClient } from "../packages/adapters/h3/dist/index.js";

const root = resolve(process.argv[2] || "apps/server/data/h3-visual-lora-eval/2026-09-28-controlled");
const env = await readEnv(resolve(".env"));
const workerUrl = process.env.H3_WORKER_URL || env.H3_WORKER_URL || "http://127.0.0.1:18080";
const serviceToken = process.env.H3_WORKER_SERVICE_TOKEN || env.H3_WORKER_SERVICE_TOKEN;
if (!serviceToken) throw new Error("H3_WORKER_SERVICE_TOKEN is unavailable.");
const prompt = "A cinematic medium close-up of a woman in a black blouse standing in a neutral photography studio. She turns slowly from left profile to direct eye contact while the camera performs a gentle push-in. Natural skin texture, restrained contrast, soft window-like key light, subtle warm rim light, realistic lens depth of field, no cuts, no subtitles, no music.";
const seed = 5242017;
const cases = [
  { id: "C0", purpose: "base control before LoRA" },
  { id: "C1", purpose: "Authentic Cinematic Texture 0.7 without trigger", visualModifier: { id: "authentic_cinematic_texture", enabled: true, strength: 0.7, includeTrigger: false } },
  { id: "C2", purpose: "Authentic Cinematic Texture 0.7 with disputed DY trigger", visualModifier: { id: "authentic_cinematic_texture", enabled: true, strength: 0.7, includeTrigger: true } },
  { id: "C2M", purpose: "Authentic Cinematic Texture documented high-motion strength 0.5 without trigger", visualModifier: { id: "authentic_cinematic_texture", enabled: true, strength: 0.5, includeTrigger: false } },
  { id: "C0R", purpose: "base control after LoRA for contamination check" },
];
await mkdir(root, { recursive: true });
await writeJson(join(root, "plan.json"), { createdAt: new Date().toISOString(), provider: "local", model: "MATLOW fused Turbo INT8", modelRevision: "8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3", modifier: { source: "civitai:2890588/version:3267949", sha256: "51dda79218ea126cbb2e08f3a6d9cc595e2224f4977d7618061954043a8bafcf" }, prompt, seed, cases });
const client = createH3WorkerClient({ baseUrl: workerUrl, serviceToken, pollingIntervalMs: 3_000, timeoutMs: 2 * 60 * 60_000 });
const results = [];

for (const test of cases) {
  const directory = join(root, test.id);
  await mkdir(directory, { recursive: true });
  const previous = await readJsonIfExists(join(directory, "metadata.json"));
  if (previous?.status === "succeeded") { results.push(previous); process.stdout.write(`${test.id}: already complete\n`); continue; }
  const input = { prompt, duration: 5, aspectRatio: "16:9", seed, variants: 1, renderMode: "preview", modelVariant: "h3_base", inferenceSteps: 4, quality: "lossless", ...(test.visualModifier ? { visualModifier: test.visualModifier } : {}) };
  await writeJson(join(directory, "request.json"), input);
  const startedAt = new Date();
  const attemptRevision = test.id === "C2M" ? "v2" : "v1";
  let job = await client.create(input, `h3-visual-lora:2026-09-28:${test.id}:${seed}:${attemptRevision}`);
  process.stdout.write(`${test.id}: accepted ${job.id}\n`);
  let lastStage = "";
  while (!["succeeded", "completed", "failed", "cancelled"].includes(job.status)) {
    if (job.stage !== lastStage) { lastStage = job.stage || ""; process.stdout.write(`${test.id}: ${job.status} ${lastStage} ${Math.round((job.progress || 0) * 100)}%\n`); }
    await delay(3_000);
    job = await client.get(job.id);
  }
  if (!["succeeded", "completed"].includes(job.status)) {
    const message = typeof job.error === "string" ? job.error : job.error?.message || `job ${job.status}`;
    const metadata = { status: "failed", id: test.id, purpose: test.purpose, jobId: job.id, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), error: message, workerJob: job };
    await writeJson(join(directory, "metadata.json"), metadata);
    results.push(metadata);
    throw new Error(`${test.id}: ${message}`);
  }
  const result = await client.result(job.id);
  const outputPath = join(directory, "output.mp4");
  await writeFile(outputPath, Buffer.from(await client.download(job.id, 0)));
  createReviewAssets(outputPath, directory);
  const metadata = { status: "succeeded", id: test.id, purpose: test.purpose, jobId: job.id, startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt.getTime(), outputPath, media: probe(outputPath), workerResult: result };
  await writeJson(join(directory, "metadata.json"), metadata);
  results.push(metadata);
  process.stdout.write(`${test.id}: complete ${(metadata.latencyMs / 1000).toFixed(1)}s\n`);
}
await writeJson(join(root, "run.json"), { completedAt: new Date().toISOString(), prompt, seed, results });

function probe(path) { const raw = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" })); const video = raw.streams.find((stream) => stream.codec_type === "video"); const audio = raw.streams.find((stream) => stream.codec_type === "audio"); return { durationSeconds: Number(raw.format?.duration || 0), sizeBytes: Number(raw.format?.size || 0), video: { codec: video?.codec_name, width: video?.width, height: video?.height, frameRate: video?.avg_frame_rate }, audio: audio ? { present: true, codec: audio.codec_name, channels: audio.channels, sampleRate: Number(audio.sample_rate) } : { present: false } }; }
function createReviewAssets(path, directory) { execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", path, "-frames:v", "1", join(directory, "thumbnail.jpg")]); execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vf", "fps=1,tile=5x1", "-frames:v", "1", join(directory, "review-strip.jpg")]); }
async function readEnv(path) { const values = {}; const text = await readFile(path, "utf8").catch(() => ""); for (const line of text.split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, ""); } return values; }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
async function readJsonIfExists(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
