# Video Upscale productionization — 2026-10-04

**VIDEO UPSCALE PRODUCTIONIZATION: COMPLETE**

The current bake-off is **COMPLETED FOR CURRENT PRODUCTION DECISION**. VimeoScale is the current verified conservative local Video Upscale default for the tested H3 Max generated-video class, not a claim that it is universally the best upscaler.

## User flow

Open H3 Studio (`/h3`). The separate **Video Upscale** composer appears above Request Composer. Import a video or choose an existing Queue result, leave **Native 2×**, then **Add to Queue**. Select the job and **Run Video Upscale · Local GPU** in the existing Queue. Upscale is explicit; generation does not enqueue it automatically.

Simple mode shows VimeoScale 2×, scoped verification, license, input, output, original audio, and Local GPU. **Advanced settings** is collapsed by default and contains model selection, native scale/context information, chunk/overlap, codec, CRF, preset, GOP, audio, color/device information and resource thresholds. **Use Vimeo production profile** restores all defaults in one click.

Copy/edit, selection, reordering, archive, results and cancellation use the existing H3 Queue. Model Gateway `local_video_upscale` uses the same contained production runner through its existing job/executor architecture. No new queue or route document format was added. Existing stored queue items remain readable; `video_upscale` and `videoUpscale` settings are additive local queue fields.

## Exact production profile

| Setting | Value |
|---|---|
| Model | `openmodeldb/vimeoscale-unet-x2` |
| Name | VimeoScale 2× — Conservative Video |
| Model scale / context | 2× / 3 frames |
| Chunk / overlap | 3 / 1 frame |
| Backend / device | PyTorch / local CUDA |
| Audio | Original stream copy |
| Color | Explicit SDR BT.709 decode → RGB24 → explicit limited BT.709 encode |
| Codec / container | H.264 (`libx264`) / MP4 |
| Preset / CRF / GOP | medium / 18 / 48 |
| FPS | Source CFR FPS including fractional rates, never a fixed 24 fps |
| Delivery | Native by default; optional downstream fit/pad |

Description: Temporal 2× upscale optimized for preserving motion and appearance. Best for clean generated/video sources where conservative enlargement is preferred over aggressive detail invention.

Verification label: **Verified · H3 Max / CUDA / 2× tested**. Scope: H3 Max source 1344×768, 24 fps, 124 frames; native 2688×1536. No detail restoration, face enhancement or identity restoration claims.

## Geometry, audio and color

Pipeline: source → temporal model at native input size → native scale → optional delivery resize/pad → encode/mux. No source prescale. Delivery canvas and model scale are separate settings. For the tested 7:4 video, native 2688×1536 fits as 2520×1440 content in 2560×1440 with 20 px on each side. Generic geometry uses the input ratio, preserves the whole frame and pads; no crop. Dimensions round to even pixels for YUV420p, with at most pixel rounding in the aspect ratio. Output SAR=1. Non-square source SAR is explicitly rejected by this SDR profile.

Source CFR timing, including fractional rates, is preserved. Sources whose average and nominal frame rates disagree are explicitly rejected as unsupported timing by this conservative profile. Original audio streams are copied by default, without `-shortest`. Unsupported MP4 audio copy fails with a clear message; the user can explicitly choose AAC re-encode in Advanced. No new sound is generated and there is no automatic audio re-encode.

Missing input tags stay missing in source provenance. Interpretation is recorded as **BT.709 SDR assumed**, with range separately tagged/assumed. Full-range tagged BT.709 input is decoded explicitly as full range. HDR, other tagged color spaces and 10-bit input are rejected by the current SDR profile. `ffprobe` verifies output `color_primaries`, `color_transfer`, `color_space`, `color_range`, raster dimensions, codec, pixel format, SAR, frame count and FPS. Original copied audio codec/rate/channel metadata is verified. Synthetic smoke additionally checks exact audio packet hashes.

## Resource guards and lifecycle

Before worker/model startup: cross-process exclusive active lock, bake-off lock check, port 8092 check, stale upscale worker check, free VRAM ≥8192 MiB, available RAM ≥4096 MiB, installed checkpoint size/SHA validation. No automatic download or stale-lock removal. One local upscale job at a time across H3 Queue and Model Gateway.

Owned Windows Job Object containment and two-CPU affinity are reused from the tested infrastructure. Runtime monitoring keeps RAM ≥4096 MiB, free VRAM ≥512 MiB; sustained CPU limits remain 180% of one core / 85% system for 10 seconds. External GPU processes are never killed. Failed resource gates become **Blocked by resources**. Missing CUDA produces an explicit error; production rejects `auto` and `cpu`. ONNX experimental models also use the reviewed strict CUDA-only session and provider-profile verification.

One worker starts for one job, then authenticated bounded shutdown (15 seconds) classifies **CLEAN / DELAYED_CLEAN / UNCLEAN / UNKNOWN**. CLEAN and DELAYED_CLEAN pass. UNCLEAN/UNKNOWN fail and preserve diagnostics; only contained owned processes may receive forced cleanup. An unverified cleanup retains the active lock for manual inspection. JSON diagnostics, resource samples and worker log stay alongside the Queue output. Cancellation requests the contained job to stop and follows the same shutdown path.

## Provenance

Queue `resultMetadata.provenance` and result diagnostics preserve source asset/path/name and SHA, model ID and actual model SHA, model scale/context, backend/device, profile/settings, native and final resolution/geometry, frame count/FPS, audio handling and re-encode flag, original color metadata and interpretation, verified output tags, runtime, output SHA, software versions and shutdown diagnostics. Model Gateway outputs retain the same provenance.

## Models and separate capabilities

| Group | Model | Status | Registry license |
|---|---|---|---|
| Production | VimeoScale 2× | Verified, scoped H3 Max/CUDA/2× | CC-BY-SA-4.0 |
| Experimental / Manual | PurePhoto SPAN 4× — Framewise Photo | Tested, not selected; normalized portrait crops did not show convincing useful detail gain over Vimeo | CC-BY-SA-4.0 |
| Experimental / Manual | GameUp TSCUNet 2× — Temporal / Noncommercial | Unverified, not required for this production decision | CC-BY-NC-SA-4.0 · NONCOMMERCIAL |
| Experimental / Manual | Other existing entries | Unverified | Existing registry information |

Registry entries are retained. Selecting an experimental model is manual. License labels repeat registry information without additional legal conclusions.

**Video Upscale ≠ H3 Regenerate 2K**. Hosted MiniMax Regeneration remains a separate paid re-render/re-interpretation capability with its existing implementation. It is not an automatic finalizer; it can change fine appearance/identity, and the current comparison did not establish a convincing quality gain.

## Audit trail

- [Bake-off and current production decision](research/video-upscale-bakeoff-2026-10-01.md)
- [Vimeo comparison continuation](research/vimeo-comparison-continuation-2026-10-04.md)
- [PurePhoto SPAN controlled run](research/purephoto-span-controlled-run-2026-10-04.md)
- [Existing full-speed comparison and artifacts](../apps/server/data/video-upscale-eval/2026-09-30/controlled/comparison/index.html)

Research media, contact sheets, crops, telemetry, preflights and failed/blocked attempts were preserved. Productionization runs only mocked queue/UI tests and tiny synthetic FFmpeg smoke tests, with no neural benchmark, GameUp inference, SPAN pass or repeated Vimeo inference.

## Deployment and limitations

Build/restart the local API and Studio after updating the source. The existing worker `.venv`, installed weights, NVIDIA CUDA and `ffprobe` on PATH are required; alternatively configure `LOCAL_VIDEO_UPSCALE_FFPROBE_PATH`. The production runner starts/stops its own worker; the user does not need a manually started upscale HTTP server or token. Model downloads remain explicit. Live neural inference was intentionally not repeated during this task.

## Focused verification completed

- Server: 59 tests across `video-upscale`, H3 Queue, session runtime, persistence, provider routes and model API. The new production/gateway tests pass with mocked execution and preserve provenance. Server TypeScript build passed.
- Studio: 33 tests across Video Upscale composer, H3 Queue panel and the separate regeneration status. TypeScript + Vite production build passed; existing bundle size warnings remain.
- Worker: 53 focused tests across production video, pipeline, registry, temporal context, benchmark safety/lifecycle, API, runtime CUDA fallback rejection and CUDA dependency pins. Production script/worker Python compilation passed.
- Browser: isolated synthetic fixture using the real Queue serializer; selected a Queue source, selected Delivery, checked GameUp Unverified/NC and Experimental grouping, restored Vimeo defaults, clicked Add to Queue and verified the persisted profile. The fixture had no neural run endpoint, and its temporary servers were stopped.
- Media smoke: two six-frame synthetic clips with mock runtime and real FFmpeg/ffprobe, Native and Delivery. Frame count/FPS, color tags, SAR, provenance hashes and audio packet hashes passed. No research artifact was overwritten.
- `git diff --check` passed. `graphify update .` rebuilt the AST graph without LLM/API calls; documentation semantic re-extraction was not requested.

## Files changed for this task

Existing unrelated working-tree edits were preserved. Generated Studio/server build outputs and graphify artifacts are separate from the source list below.

| Area | Files |
|---|---|
| Server services | `apps/server/src/services/video-upscale.ts`, `video-upscale.test.ts`, `h3-queue.ts`, `h3-session-runtime.ts` |
| Server API/execution | `apps/server/src/routes/h3.ts`, `models.ts`, `apps/server/src/execution/service.ts`, `apps/server/src/providers/provider-node-manifests.ts` |
| Studio | `apps/studio/src/features/h3/VideoUpscaleComposer.tsx`, `VideoUpscaleComposer.test.ts`, `H3QueuePanel.tsx`, `H3Studio.css` |
| Worker entry/service/registry | `workers/local-upscale/app/main.py`, `benchmark_worker.py`, `video_service.py`, `video_registry.py`, `workers/local-upscale/video-model-registry.json` |
| Worker pipeline/runtime | `workers/local-upscale/app/video_production.py`, `video_pipeline.py`, `video_runtime.py`, `runtime.py`, `video_benchmark.py` |
| Worker orchestration/tests | `workers/local-upscale/scripts/run_video_production.py`, `workers/local-upscale/tests/test_video_production.py` |
| Documentation | `docs/video-upscale-production.md`, `docs/local-upscale.md`, `docs/research/video-upscale-bakeoff-2026-10-01.md` |

The already running local API had not loaded the new endpoint during verification (`/api/h3/video-upscale` returned 404). Restart that API and reopen/reload Studio to activate the new source/build. No additional benchmark or model download is needed for this installed/tested Vimeo setup.
