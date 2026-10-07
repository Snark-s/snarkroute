import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerRequest,
  normalizePlan,
  summarizeRun,
} from "./h3-ref2va-eval-lib.mjs";

test("normalizes a controlled plan without changing reference order", () => {
  const plan = normalizePlan({
    defaults: { seed: 424242, steps: 4, durationSeconds: 5, aspectRatio: "16:9" },
    tests: [{
      id: "PV1",
      prompt: "A woman turns toward the camera.",
      contextInstruction: "Use <Picture 1> for appearance. Use <Video 1> for motion.",
      references: [
        { kind: "image", path: "picture.png", purpose: "appearance" },
        { kind: "video", path: "motion.mp4", visualMode: "motion" },
      ],
    }],
  }, "C:/suite/plan.json");

  assert.equal(plan.tests[0].seed, 424242);
  assert.deepEqual(plan.tests[0].references.map((reference) => reference.tag), ["Picture 1", "Video 1"]);
  assert.match(plan.tests[0].finalPrompt, /^Use <Picture 1>/);
});

test("builds text-only and Ref2VA worker requests with FaceSwap as a modifier", () => {
  const baseline = buildWorkerRequest({
    id: "A0", prompt: "neutral", finalPrompt: "neutral", seed: 7, steps: 4,
    durationSeconds: 5, aspectRatio: "16:9", modelVariant: "h3_base", references: [],
  }, []);
  assert.equal(baseline.task, "t2va");
  assert.equal(baseline.conditions.length, 0);

  const faceswap = buildWorkerRequest({
    id: "F1", prompt: "preserve motion", finalPrompt: "preserve motion", seed: 7, steps: 4,
    durationSeconds: 5, aspectRatio: "16:9", modelVariant: "h3_base",
    identityTransfer: { enabled: true, strength: 1 },
    references: [
      { kind: "video", purpose: "motion", visualMode: "full" },
      { kind: "image", purpose: "identity" },
    ],
  }, ["file:///video.mp4", "file:///face.png"]);
  assert.equal(faceswap.task, "ref2va");
  assert.deepEqual(faceswap.identity_transfer, { enabled: true, strength: 1 });
  assert.deepEqual(faceswap.conditions.map((item) => item.purpose), ["motion", "identity"]);
});

test("summarizes completed and failed runs for the HTML report", () => {
  const summary = summarizeRun([
    { id: "S0", status: "succeeded", metadata: { render_time_seconds: 10 } },
    { id: "S1", status: "failed", error: "CUDA error" },
  ]);
  assert.deepEqual(summary, { total: 2, succeeded: 1, failed: 1, pending: 0 });
});
