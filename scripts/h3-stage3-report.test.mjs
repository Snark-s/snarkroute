import test from "node:test";
import assert from "node:assert/strict";
import { summarizePipeline, summarizeContamination } from "./h3-stage3-report.mjs";

test("blocked local M2K preserves Max source lineage without claiming a 2K result", () => {
  const source = { jobId: "max-job", outputPath: "/max.mp4", sha256: "abc", media: { video: { width: 1344, height: 768 } } };
  const result = summarizePipeline(source);
  assert.equal(result.source.provider, "fal");
  assert.equal(result.source.jobId, source.jobId);
  assert.equal(result.source.sha256, source.sha256);
  assert.equal(result.source.media.video.width, 1344);
  assert.equal(result.requestedFinalization.resolution, "2K");
  assert.equal(result.status, "blocked");
  assert.equal(result.outputPath, null);
  assert.equal(result.media, null);
  assert.equal(result.peakVramGiB, null);
  assert.equal(result.acceptanceTest, "not_run_no_local_regenerate_backend");
});
test("contamination evidence passes only on full output hash equality", () => {
  assert.equal(summarizeContamination("same", "same").status, "passed");
  assert.equal(summarizeContamination("before", "after").status, "failed");
});
