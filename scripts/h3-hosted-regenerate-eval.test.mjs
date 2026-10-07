import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { EXPECTED_SOURCE_SHA, estimateControlledCost, redactMedia, reserveSubmission, resolveOriginalConditioning, validateSource } from "./h3-hosted-regenerate-eval.mjs";

function validMedia() { return { streams: [{ codec_type: "video", width: 1344, height: 768, avg_frame_rate: "24/1", nb_frames: "124", nb_read_packets: "124" }, { codec_type: "audio", sample_rate: "32000", channels: 2 }], format: { duration: "5.184", format_name: "mov,mp4" } }; }

test("MAX-I1 satisfies measured source constraints", () => {
  const result = validateSource(validMedia(), EXPECTED_SOURCE_SHA, 4826842);
  assert.equal(result.passed, true);
  assert.equal(result.frameCount, 124);
  assert.deepEqual(result.failures, []);
});

test("hard source failures prevent submission eligibility", () => {
  for (const mutate of [m => m.streams[0].width++, m => m.streams[0].avg_frame_rate = "25/1", m => m.streams[0].nb_frames = "125", m => m.streams.pop(), m => m.streams[0].nb_read_packets = "123"]) {
    const media = validMedia(); mutate(media);
    assert.equal(validateSource(media, EXPECTED_SOURCE_SHA, 4826842).passed, false);
  }
  assert.equal(validateSource(validMedia(), "wrong_sha", 4826842).passed, false);
  assert.equal(validateSource(validMedia(), EXPECTED_SOURCE_SHA, 50_000_001).passed, false);
});

test("estimated cost includes only relevant original materials and stays invoice unverified", () => {
  assert.equal(estimateControlledCost(5.184).totalEstimatedUsd, 0.2592);
  assert.equal(estimateControlledCost(5, 6, 2).totalEstimatedUsd, 0.375);
  assert.equal(estimateControlledCost(5).actualBillingUsd, null);
});

test("original metadata forwards exact prompt and one first frame, never a fal source_task_id", () => {
  const request = { body: { prompt: "Exact final prompt", prompt_expansion_mode: "disabled" }, assets: [{ kind: "image", role: "firstFrame" }] };
  const metadata = { requestId: "01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d", provider: "fal", model: "fal/minimax-h3-max", expandedPrompt: null };
  const result = resolveOriginalConditioning(request, metadata, Buffer.from([1, 2, 3]));
  assert.equal(result.prompt, request.body.prompt);
  assert.equal(result.references[0].role, "first_frame");
  assert.equal(result.references[0].uri, "data:image/jpeg;base64,AQID");
  assert.equal(result.source_task_id, undefined);
  assert.throws(() => resolveOriginalConditioning({ ...request, assets: [] }, metadata, Buffer.from([1])), /conditioning/);
  assert.throws(() => resolveOriginalConditioning(request, { ...metadata, expandedPrompt: "Unknown rewrite" }, Buffer.from([1])), /final prompt/);
});

test("persistent submission reservation cannot be acquired twice, including concurrently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "h3-hosted-one-attempt-"));
  try {
    const reservations = await Promise.allSettled([reserveSubmission(directory), reserveSubmission(directory)]);
    assert.equal(reservations.filter(r => r.status === "fulfilled").length, 1);
    await assert.rejects(reserveSubmission(directory), { code: "EEXIST" });
  } finally {
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    assert.ok(basename(directory).startsWith("h3-hosted-one-attempt-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("request audit removes inline media and credentials", () => {
  assert.deepEqual(redactMedia({ prompt: "original", apiKey: "secret", image: "data:image/jpeg;base64,AQID" }), { prompt: "original", image: "[inline image/jpeg; representation recorded separately]" });
});
