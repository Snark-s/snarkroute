# Vimeo controlled run — 2026-10-01, Europe/Moscow

**BENCHMARK: FAILED at worker shutdown check. Native CUDA job: SUCCEEDED.** Exactly one approved job, no warmup or retry, no SPAN/GameUp. Normalization/baseline/review media were not rendered.

User approval: “Запускай Vimeo”. Model `openmodeldb/vimeoscale-unet-x2`, CUDA, scale2, context3, chunk3/overlap1, libx264 medium CRF18/GOP48, two-thread pool caps and aggregate two-logical-CPU affinity, explicit assumed BT.709 color path, original AAC copy. Source/checkpoint SHA gates passed before startup. Model license: CC-BY-SA-4.0.

Job `vup_ed035e79-9c5a-46f4-976e-65e4529111c8` processed 124 frames into 2688×1536 / 24 fps / H.264 YUV420P, 6,517,030 bytes. [Native video](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/native.mp4). Independent metadata/audio validation: **FAILED**. [Verification JSON](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/native-verification.json).

| Measurement | Result |
|---|---:|
| Worker startup | 1.623 s |
| Cold model load | 12.251 s |
| Worker processing | 227.959 s |
| Inference wrapper | 207.077 s |
| CUDA model forward | 194.325 s |
| Runtime preprocessing | 3.965 s |
| Runtime postprocessing | 8.325 s |
| Decode pipe wait | 1.220 s |
| Encode pipe wait | 1.512 s |
| Encoder finalization wait | 5.497 s |
| Native audio mux | 0.080 s |
| Full harness wall, failed | 234.684 s |
| Torch peak allocated | 5217.0 MiB |
| Torch peak reserved | 9616.0 MiB |
| System GPU used peak | 11643 MiB |
| System GPU free minimum | 4533 MiB |
| Owned CPU peak, 100%=one logical CPU | 177.65% |
| Total CPU peak | 69.26% |
| Owned active RSS peak | 2.195 GiB |
| Available RAM minimum | 12.706 GiB |
| Resource samples | 112 |

These samples are not instantaneous exhaustive peaks. Decode/encode overlap inference; pipe waits are not codec compute durations and cannot be added to wall. Torch peaks differ from system GPU memory. Normalization timing is unavailable because it was not run.

GPU precheck: used 1857 / free 14319 MiB, exceeding required free 8192 MiB. After cleanup: used 1802 / free 14374 MiB. All owned processes exited; active.lock released, persistent vimeo.attempt.json retained. Port 8092 has no listener. VRAM deltas cannot prove exact model allocation under WDDM/concurrent external workloads.

Harness error: `Worker/children did not exit cleanly`. Worker log is empty; the triggering worker return code/active-process snapshot was not recorded. The cause could not be established from saved evidence, and is not called an inference failure or proven false-positive. Final cleanup did confirm zero owned processes. No code or settings were changed to bypass the failure; no normalization or retry followed.

Independent metadata check found discrepancies: `[{"field": "color_transfer", "expected": "bt709", "actual": null}, {"field": "color_primaries", "expected": "bt709", "actual": null}]`. CLI encode options were explicit but the actual output does not prove the complete approved BT.709 tag profile. Source BT.709 remains a **TEST ASSUMPTION**, not a recovered source fact. Original AAC packet-size/hash identity: **True**; source SHA and output SHA are in verification JSON. This verifies encoded payload identity, not perceptual sync. No model-quality conclusion or winner: normal-speed visual review remains pending, normalized source baseline and other candidates do not exist from this run.

Artifacts: [Raw result](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/result.json), [summary](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/run-summary.json), [submitted job](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/controlled/vimeo/submitted-job.json). Raw FAILED result is retained unchanged. Stop here; wait for a separate instruction before troubleshooting/recovery, normalization, retry or another candidate.
