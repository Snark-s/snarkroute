import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createH3WorkerClient } from "../packages/adapters/h3/dist/index.js";

const root = resolve(process.argv[2] || "apps/server/data/h3-max-eval/2026-09-27-controlled");
const directory = join(root, "BASE-I1");
const firstPath = join(root, "inputs", "first.jpg");
const env = await readEnv(resolve(".env"));
const workerUrl = process.env.H3_WORKER_URL || env.H3_WORKER_URL || "http://127.0.0.1:18080";
const serviceToken = process.env.H3_WORKER_SERVICE_TOKEN || env.H3_WORKER_SERVICE_TOKEN;
if (!serviceToken) throw new Error("H3_WORKER_SERVICE_TOKEN is unavailable.");
await mkdir(directory, { recursive: true });

const prompt = `A photorealistic studio portrait of the same woman in a black blouse. She begins in left profile, pauses, then turns her head smoothly toward the lens and settles into direct eye contact. The camera performs one slow, steady push-in from a medium close-up to a tighter close-up; no cuts, no reframing jumps. Soft neutral key light remains stable while a subtle warm rim light grows along her hair. End state: she faces the camera squarely, completely still, with a calm focused expression. Natural synchronized sound: quiet studio room tone, a soft fabric rustle during the turn, one gentle breath, and a single camera-shutter click exactly after she becomes still. No dialogue, no music, no subtitles.`;
const client = createH3WorkerClient({ baseUrl: workerUrl, serviceToken, pollingIntervalMs: 2_000, timeoutMs: 60 * 60_000 });
const first = await readFile(firstPath);
const uploaded = await client.upload(first, basename(firstPath), "image/jpeg");
const input = { prompt, duration: 5, aspectRatio: "16:9", seed: 5242017, variants: 1, renderMode: "preview", modelVariant: "h3_base", inferenceSteps: 4, quality: "lossless", references: [{ kind: "image", role: "firstFrame", uri: uploaded.uri }] };
await writeJson(join(directory, "request.json"), { ...input, references: [{ kind: "image", role: "firstFrame", source: firstPath }] });
const started = Date.now();
let job = await client.create(input, "h3-max-controlled:BASE-I1:5242017");
process.stdout.write(`BASE-I1: accepted ${job.id}\n`);
let lastStage = "";
while (!["succeeded", "completed", "failed", "cancelled"].includes(job.status)) {
  if (job.stage !== lastStage) { lastStage = job.stage || ""; process.stdout.write(`BASE-I1: ${job.status} ${lastStage} ${Math.round((job.progress || 0) * 100)}%\n`); }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000));
  job = await client.get(job.id);
}
if (!["succeeded", "completed"].includes(job.status)) throw new Error(typeof job.error === "string" ? job.error : job.error?.message || `Base job ${job.status}.`);
const result = await client.result(job.id);
const outputPath = join(directory, "output.mp4");
await writeFile(outputPath, Buffer.from(await client.download(job.id, 0)));
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", outputPath, "-frames:v", "1", join(directory, "thumbnail.jpg")]);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", outputPath, "-vf", "fps=1,tile=5x1", "-frames:v", "1", join(directory, "review-strip.jpg")]);
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath], { encoding: "utf8" }));
const audio = probe.streams.find((stream) => stream.codec_type === "audio");
const video = probe.streams.find((stream) => stream.codec_type === "video");
await writeJson(join(directory, "metadata.json"), { status: "succeeded", id: "BASE-I1", jobId: job.id, provider: "local", model: "MiniMaxAI/MiniMax-H3 Base FL2VA", upstream: "MiniMax", latencyMs: Date.now() - started, outputPath, media: { durationSeconds: Number(probe.format.duration), sizeBytes: Number(probe.format.size), video: { codec: video?.codec_name, width: video?.width, height: video?.height }, audio: audio ? { present: true, codec: audio.codec_name, channels: audio.channels, channelLayout: audio.channel_layout, sampleRate: Number(audio.sample_rate) } : { present: false } }, workerResult: result });
process.stdout.write(`BASE-I1: complete ${((Date.now() - started) / 1000).toFixed(1)}s audio=${Boolean(audio)}\n`);

async function readEnv(path) {
  const values = {};
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
