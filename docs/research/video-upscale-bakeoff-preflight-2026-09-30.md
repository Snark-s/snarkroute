# Local video upscale bake-off — research and preflight, 2026-09-30

**Current status, 2026-10-01: Vimeo full benchmark FAILED; next-test readiness NO.** Native CUDA job completed, but shutdown verification and independent color-tag validation failed. Native audio packet identity passed; no normalization, retry or other candidate. See [execution report](Y:/Процесс/SnarkRoute/docs/research/vimeo-controlled-run-2026-10-01.md). Preparation-only findings below are historical.

**READY FOR UPSCALE TEST: YES — implementation preparation only; execution is not authorized.** No local inference, GPU model loading, CPU model execution, warmup, model conversion/download, whole-video frame extraction, remux, upscale or benchmark render occurred. Initial preflight used registry/source reads, weight stat/SHA, header-only ffprobe and read-only hardware/health queries. Resource preparation added opt-in code, pure/mock tests and a focused TypeScript build. No worker was started and no output video was created.

Initial findings below describe the ordinary worker and earlier hardware snapshot. The **RESOURCE-CONTROL PREPARATION** section records the new opt-in benchmark mode. All selected models remain MAX-I1 unverified; live GPU readiness is not established by preparation.

Hosted MiniMax H3 Regenerate remains a separate re-render/re-interpretation capability. The user's visual assessment is that fine appearance changed without convincing detail gain; it is not an automatic finalizer. No H3 generation/regeneration/LoRA/FaceSwap/CameraPath/import/decision/routing/interpolation/restoration experiments were changed.

## Scope and actual architecture

Graphify scoped the shared local-upscale worker, video adapter and registry. Minimum implementation area inspected: `workers/local-upscale/app/{video_registry,video_runtime,video_pipeline,video_service,runtime,config,registry,tiling}.py`, two registries, dependency metadata, API entrypoint, local-video adapter, server catalog mapping and the generic node parameter UI. The existing benchmark script was read only to learn its request format and locate relevant historical performance evidence. Two old summary JSON files at the script's exact report location were inspected because the user requested existing-log resource analysis; archives and unrelated reports were not searched.

Path: Studio generic `NodeParamsController` model/manifest panel → Model Gateway `video.upscale` / `local_video_upscale` → existing TypeScript adapter → authenticated shared Python worker `/v1/video` → registry / runtime → streaming FFmpeg decode, model processing, native-scale libx264 encode and original-audio mux → adapter result/provenance. Models are not loaded merely by constructing the runtime factories; factories cache them after job execution.

Backends implemented:

- Image PyTorch/Spandrel becomes `framewise/<image model id>`, context 1. Spatial tiling with overlap/blended weights, sequential tiles/frames. Current path FP32; no half/autocast.
- Image ONNX Runtime CUDA (DAT2) is another spatial framewise path, FP32 input/output. TensorRT is an extension hook, **not an implemented backend**.
- TSCUNet ONNX: five RGB frames flattened to NCHW 15 channels, center frame output; reflect-pad to 64 multiples. MAX-I1 already meets this alignment. Runtime input is float32; pinned filename advertises fp16 internals, not independently graph-parsed here.
- SOFVSR PyTorch: multi-frame optical flow plus Spandrel RRDB reconstruction for Vimeo/REDSVAL; one center frame per invocation. CUDA half, CPU float32. TSSM uses luminance SR with bicubic center chroma.
- NanoVSR PyTorch: bidirectional recurrent sequence, CUDA half, configured 15-frame chunk/context; state is restarted across calls, not full-clip persistent recurrence. Chunk boundaries need review.

No temporal spatial tiling is implemented. `chunk_size` controls decoded/output accumulation, not parallel inference batching or guaranteed GPU activation reduction for fixed-window center-frame models. Temporal overlap is measured in frames; spatial overlap in input pixels. No automatic OOM tile retry exists. `device=cuda` is proposed, never auto/CPU fallback; ORT may still execute individual unsupported operations on CPU.

## Installed versus configured versus verified

Worker dependencies are present in `workers/local-upscale/.venv`: Python 3.12.9, torch 2.7.1+cu128, torchvision 0.22.1+cu128, Spandrel 0.4.1, onnxruntime-gpu 1.22.0, numpy 2.2.6, imageio-ffmpeg 0.6.0. Versions were read from distribution metadata; CUDA libraries/models were not initialized. This establishes installation, not a successful present CUDA session.

Root server `.env` configures `http://127.0.0.1:8091`. Both read-only health and capabilities requests returned connection refused; worker was not started. Worker `.env` records `LOCAL_UPSCALE_MODEL_DIR=./models`, data `./data`, runtime `auto`; Python Settings reads process environment, not this dotenv file itself. Relative paths depend on the launch cwd. Expected installed location is **Y:/Процесс/SnarkRoute/workers/local-upscale/models/**. Any later launch must explicitly use worker cwd and load/pass its env; no new env file was invented.

There are **16 video registry entries: 5 temporal + 11 framewise**. **13 weight files installed**, all exact size and SHA verified; **3 missing**. Historical CUDA fixtures are evidence only for those old inputs/code. All candidates remain **MAX-I1 unverified**.

| Model ID | Scale | Context / class | Runtime | Pinned bytes | License label | State / historical evidence |
|---|---:|---|---|---:|---|---|
| `nanovsr-644k-x4` | 4× | temporal 15f | pytorch | 3,001,663 | MIT | Installed / MAX-I1 unverified; Not established |
| `openmodeldb/gameup-v2-tscunet-small-x2` | 2× | temporal 5f | onnxruntime | 43,760,071 | CC-BY-NC-SA-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `openmodeldb/vimeoscale-unet-x2` | 2× | temporal 3f | pytorch | 21,938,817 | CC-BY-SA-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `openmodeldb/redsval-7f-rrdb-lite-x4` | 4× | temporal 7f | pytorch | 22,343,759 | CC-BY-NC-SA-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `openmodeldb/video-tssm-x3` | 3× | temporal 3f | pytorch | 4,730,412 | CC-BY-NC-SA-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `framewise/4x-realesrgan-x4plus` | 4× | spatial, 1f | pytorch | 67,040,989 | BSD-3-Clause | Installed / MAX-I1 unverified; Not established |
| `framewise/4x-realesrgan-x4plus-anime-6b` | 4× | spatial, 1f | pytorch | 17,938,799 | BSD-3-Clause | Missing weights; Not established |
| `framewise/4x-realesr-general-x4v3` | 4× | spatial, 1f | pytorch | 4,885,111 | BSD-3-Clause | Missing weights; Not established |
| `framewise/4x-realesr-general-wdn-x4v3` | 4× | spatial, 1f | pytorch | 4,885,111 | BSD-3-Clause | Missing weights; Not established |
| `framewise/4x-purephoto-span` | 4× | spatial, 1f | pytorch | 9,016,490 | CC-BY-SA-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `framewise/4x-nomoswebphoto-realplksr` | 4× | spatial, 1f | pytorch | 29,683,482 | CC-BY-4.0 | Installed / MAX-I1 unverified; Not established |
| `framewise/4x-ultrasharp-v2-dat2-onnx` | 4× | spatial, 1f | onnxruntime | 51,800,517 | CC-BY-NC-SA-4.0 | Installed / MAX-I1 unverified; Not established |
| `framewise/4x-lexica-hat` | 4× | spatial, 1f | pytorch | 85,149,569 | CC-BY-4.0 | Installed / MAX-I1 unverified; Not established |
| `framewise/4x-hfa2k-ludvae-grl-small` | 4× | spatial, 1f | pytorch | 31,569,449 | CC-BY-4.0 | Installed / MAX-I1 unverified; Yes, 6-frame CUDA fixture |
| `framewise/4x-hfa2k-ludvae-swinir-light` | 4× | spatial, 1f | pytorch | 17,225,509 | CC-BY-4.0 | Installed / MAX-I1 unverified; Not established |
| `framewise/4x-realwebphoto-v2-rgt-s` | 4× | spatial, 1f | pytorch | 135,976,722 | CC-BY-4.0 | Installed / MAX-I1 unverified; Not established |

Licenses and provenance for additional image entries are registry declarations, not a new legal audit. For the requested temporal checkpoints and selected SPAN, cards/source were checked: [GameUp](https://openmodeldb.info/models/2x-GameUpV2-TSCUNet-Small), [Vimeo](https://openmodeldb.info/models/2x-VimeoScale-Unet), [REDSVAL](https://openmodeldb.info/models/4x-REDSVAL-7f-RRDB-Lite), [TSSM](https://openmodeldb.info/models/3x-Video-TSSM), [PurePhoto](https://openmodeldb.info/models/4x-PurePhoto-span), [NanoVSR](https://github.com/filippawlicki/nanovsr). Model license labels remain distinct from architecture/worker code licenses.

GameUp's card targets compressed game video and lists NC/SA. Vimeo is a natural/CG/video SOFVSR 2× checkpoint, SA. REDSVAL 7f RRDB Lite is **temporal SOFVSR**, not a frame-independent RRDB baseline; NC/SA. TSSM is a cartoon-trained SOFVSR 3× checkpoint; NC/SA, unsuitable as first natural-portrait candidate. PurePhoto is a photo-trained SPAN 4× image model, SA. NanoVSR source advises genuinely low-resolution input, not expensive HD use.

Upstream [TSCUNet](https://github.com/Kim2091/TSCUNet) documents a breaking ONNX change on 2025-04-07. The existing pinned older export/adapter has historical CUDA evidence; do not substitute the current upstream wrapper or reconvert without a separate decision. SOFVSR uses the existing adapter/source lineage; its flow scaling was checked against the referenced [BasicSR flow source](https://raw.githubusercontent.com/mansum6/BasicSR/master/codes/models/modules/architectures/video.py), not altered. External Video-Inference also supports other actions; they are not equivalent to these registered upscale models.

## Weight files and missing downloads

Every present file below was statted/hashed, with no checkpoint deserialization or model execution. Exact full SHA, URL, source page, license URL, bytes, framework, precision and per-model formats are in **preflight.json**.

| Model | Installed/expected file | Integrity |
|---|---|---|
| `nanovsr-644k-x4` | [nanovsr_644k.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/nanovsr_644k.pth) | Size + SHA match |
| `openmodeldb/gameup-v2-tscunet-small-x2` | [2x-GameUpV2_TSCUNet_Small_op17_fp16.onnx](Y:/Процесс/SnarkRoute/workers/local-upscale/models/2x-GameUpV2_TSCUNet_Small_op17_fp16.onnx) | Size + SHA match |
| `openmodeldb/vimeoscale-unet-x2` | [2x-VimeoScale-Unet.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/2x-VimeoScale-Unet.pth) | Size + SHA match |
| `openmodeldb/redsval-7f-rrdb-lite-x4` | [4x-REDSVAL-7f-RRDB-Lite.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4x-REDSVAL-7f-RRDB-Lite.pth) | Size + SHA match |
| `openmodeldb/video-tssm-x3` | [3x-Video-TSSM.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/3x-Video-TSSM.pth) | Size + SHA match |
| `framewise/4x-realesrgan-x4plus` | [RealESRGAN_x4plus.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/RealESRGAN_x4plus.pth) | Size + SHA match |
| `framewise/4x-realesrgan-x4plus-anime-6b` | `RealESRGAN_x4plus_anime_6B.pth` | Absent; no download |
| `framewise/4x-realesr-general-x4v3` | `realesr-general-x4v3.pth` | Absent; no download |
| `framewise/4x-realesr-general-wdn-x4v3` | `realesr-general-wdn-x4v3.pth` | Absent; no download |
| `framewise/4x-purephoto-span` | [4xPurePhoto-Span.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xPurePhoto-Span.pth) | Size + SHA match |
| `framewise/4x-nomoswebphoto-realplksr` | [4xNomosWebPhoto_RealPLKSR.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xNomosWebPhoto_RealPLKSR.pth) | Size + SHA match |
| `framewise/4x-ultrasharp-v2-dat2-onnx` | [4x-UltraSharpV2_fp32_op17.onnx](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4x-UltraSharpV2_fp32_op17.onnx) | Size + SHA match |
| `framewise/4x-lexica-hat` | [4xLexicaHAT.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xLexicaHAT.pth) | Size + SHA match |
| `framewise/4x-hfa2k-ludvae-grl-small` | [4xHFA2kLUDVAEGRL_small.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xHFA2kLUDVAEGRL_small.pth) | Size + SHA match |
| `framewise/4x-hfa2k-ludvae-swinir-light` | [4xHFA2kLUDVAESwinIR_light.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xHFA2kLUDVAESwinIR_light.pth) | Size + SHA match |
| `framewise/4x-realwebphoto-v2-rgt-s` | [4xRealWebPhoto_v2_rgt_s.pth](Y:/Процесс/SnarkRoute/workers/local-upscale/models/4xRealWebPhoto_v2_rgt_s.pth) | Size + SHA match |

Missing: anime-6B 17,938,799 bytes; general-x4v3 and WDN-x4v3 4,885,111 bytes each. Their official release URLs and pinned SHA are recorded in JSON; minimum final bytes total **27,709,021**, plus download staging/temporary headroom if later approved. No downloads planned for the first three candidates, all already installed. Future output file size/disk usage is unknown until codec/content are measured; stream frames instead of caching all 124 full-size outputs.

## Source and color preflight

Same MAX-I1: fal / fal/minimax-h3-max; job `01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d`; [source MP4](Y:/Процесс/SnarkRoute/apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4). SHA matches `ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`. Header-only ffprobe confirms 1344×768, yuv420p 8-bit, 24/1 fps, 124 header frames, H.264 video 5.166667 s; AAC stereo 32 kHz, 5.184 s; 4,826,842 bytes. No decoded frame extraction occurred.

**Color range/matrix/transfer/primaries are absent in ffprobe metadata.** They cannot be asserted as measured BT.709. Current decoder converts implicitly to RGB24; encoder explicitly uses RGB full → limited BT.709 YUV420P and writes BT.709 tags. This asymmetry could create contrast/color differences unrelated to model quality.

Proposed shared test convention, to be logged before execution: assume SDR BT.709 limited-range for this untagged HD H.264, explicitly decode to full-range RGB [0,1], process, explicitly encode limited BT.709. No gamma/contrast adjustment or denoise. Apply identical conversion to the source comparison baseline. Assumption is not source truth; if a reliable source color specification contradicts it, stop and revise all candidates consistently. Current worker has no parameter for this explicit decode policy, so preparation is required. Video pipeline is RGB24/YUV420P, discards alpha; it is not a 10-bit/HDR or color-managed ICC pipeline. TSSM's BT.601-like luminance conversion is another reason to exclude it initially.

## Resolution and audio plan

Source aspect is exactly 7:4. Never stretch it to 16:9 or silently crop.

| Native scale | Native result | Common displayed result |
|---|---|---|
| 2× | 2688×1536 | Lanczos → 2520×1440, pad 20 px each side → 2560×1440 |
| 3× | 4032×2304 | Same fit/padding |
| 4× | 5376×3072 | Same fit/padding |

Keep SAR=1 and exact 124 frames/24 fps. Original baseline receives the same 2520×1440 fit/padding. Native model input is always untouched 1344×768; no presizing to force model scale. The 4× spatial baseline is justified to compare a mature tiled photo model against temporal approaches, despite its extra pixels/downsample cost; no redundant 4× zoo is proposed.

Existing worker produces native scale only, then CPU libx264 medium CRF18. It has no normalized-resolution parameter. Planned later normalization is a separate explicit approved resize/encode stage, same final settings for all. This adds an encode-generation bias; retain native outputs/crops and record both codec generations. Lossless native CRF0 is possible in the existing job but would need a separately approved CPU/disk budget, so it is **not** silently selected now.

Audio is copied from source using `-map 1:a:0? -c:a copy`; no generated audio, no AAC re-encode in planned native or normalized output. Do not use `-shortest`: original audio is 17 ms longer than video. Existing `audio_preserved` merely means audio exists and copy mode was selected; later verify encoded AAC packet SHA, stream times/durations and cue/sync listening. Video-container hash will naturally change; compare audio packets separately.

## Historical performance and resource safety

Read-only hardware snapshot: RTX 3080 Laptop GPU **16,384 MiB**, **12,091 MiB used**, nominal **4,293 MiB free**, 9% utilization. RAM installed **34,204,610,560 bytes** (~31.9 GiB), not measured free RAM. Snapshot is neither an allocation budget nor peak. No process was stopped to reclaim memory.

Historical report `reports/local-video-upscale/openmodeldb-2026-08-24/performance-report.json`, generated 2026-08-24, logs the same GPU class/16 GB and CUDA. Different tiny fixtures; below are **observed old values, not MAX-I1 forecasts**:

| Model | Old input / frames | Old total s | Old inference s | Old torch allocated peak MiB |
|---|---|---:|---:|---:|
| `openmodeldb/gameup-v2-tscunet-small-x2` | 640×360 / 6 | 11.211 | 3.995 | unknown (ORT/WDDM) |
| `openmodeldb/vimeoscale-unet-x2` | 640×360 / 6 | 20.742 | 11.237 | 1175.41015625 |
| `openmodeldb/redsval-7f-rrdb-lite-x4` | 320×180 / 6 | 14.362 | 12.556 | 1732.10546875 |
| `openmodeldb/video-tssm-x3` | 426×240 / 6 | 2.342 | 1.570 | 616.65771484375 |
| `framewise/4x-purephoto-span` | 320×180 / 6 | 2.938 | 1.924 | 93.88330078125 |
| `framewise/4x-hfa2k-ludvae-grl-small` | 320×180 / 6 | 9.524 | 6.746 | 188.7197265625 |

No robust MAX-I1 expected runtime/VRAM/RAM follows from these six-frame runs. Output scale, nonlinear attention/flow behavior, padding, tile count, cold load/cache, encoder and other GPU users differ. Do not multiply those numbers into an asserted benchmark prediction. Registry estimated VRAM is null throughout. ONNX WDDM peak is unavailable in worker telemetry; torch allocated excludes other processes, some non-torch allocations and total reservation.

Deterministic buffer sizes, **not total RAM/VRAM peaks**: source RGB24 frame 2.953 MiB; 2× frame 11.813 MiB; 4× frame 47.25 MiB. Spatial 4× blend accumulator alone 189 MiB plus weight map 63 MiB; arithmetic temporaries add more. Smaller chunk=1 avoids retaining many enhanced frames. Temporal fixed 3/5/7-frame windows still allocate full-frame activations; reducing decoded chunk does not make these tiled models.

CPU stages: software decode; RGB conversion; numpy stacks/casts/padding; tile blending or temporal preparation; GPU transfers; normalization resize; native and final CPU H.264 encode; audio mux. Decode/encode overlap with inference. Current FFmpeg has no thread cap; libx264 medium can heavily occupy CPU, especially 5376×3072. Thread/concurrency priority and preset are not configurable job parameters. GPU load is compute-intensive, utilization/runtime unknown. ORT CPU-provider node fallback is possible even in a CUDA session.

Before any approved run, propose explicit decoder/encoder/filter caps of 2 threads, OMP/MKL/torch CPU cap 2 where applicable, one job, CUDA-only device selection, no auto retry. These controls need an implementation/launch plan; they cannot be expressed by pretending extra fields work in the current job. Factories retain models in caches; use a fresh isolated worker per approved candidate so the next model does not accumulate allocations. Service permits concurrent submitted jobs; the future harness must not enqueue several.

## Recommended candidates; no winner selected

| Order / candidate | Weight bytes | Scale / context | Proposed native output | Expected VRAM / RAM | CPU / GPU / runtime for 124 frames |
|---|---:|---|---|---|---|
| 1 VimeoScale | 21,938,817 | temporal 2× / 3f | 2688×1536 | unknown / unknown; no spatial tiling | Benchmark CPU capped; GPU compute-intensive full-frame flow/SR; runtime unknown |
| 2 PurePhoto SPAN | 9,016,490 | spatial 4× / 1f | 5376×3072 | unknown / unknown; tile256 limits model tile, not full-frame host arrays | Benchmark CPU capped; GPU compute-intensive; runtime unknown |
| 3 GameUp TSCUNet Small | 43,760,071 | temporal 2× / 5f | 2688×1536 | unknown / unknown; ORT peak not reported, no tiling | CPU potentially high incl. ORT fallback; GPU compute-intensive; runtime unknown |

PurePhoto: already installed, mature tiled image path, photo domain; identity drift, invented texture, oversharpening, tile seams and motion flicker remain test questions. Vimeo: best architecture/domain/scale fit to try, not a preselected quality winner; flow/occlusion and full-frame memory risks. GameUp: different temporal ONNX backend with convenient 2×; game/restoration domain and NC/SA restrictions mean it is a research candidate, not an automatic commercial production default.

Reserve REDSVAL 7f RRDB Lite 4× (22,343,759 bytes): defer because seven-frame full-frame context and 4× result increase cost, no spatial tiling, NC/SA. TSSM 3× (4,730,412 bytes) mismatches natural portrait; NanoVSR 4× (3,001,663 bytes) designed for genuinely low-resolution inputs. HFA2k GRL-small is an installed spatial alternative but its old fixture was slower and it duplicates the first baseline category. No denoise, interpolation or H3 regeneration comparison is bundled into this test.

## Exact proposed job templates — NOT SUBMITTED

Existing endpoint: `POST /api/model-gateway/jobs`. Bodies below match existing transport. `assetId` must be resolved by the existing asset import after separate approval; source path/SHA and every model parameter are fixed. They are **templates, not submit-ready jobs** while readiness is NO. No new upload stack, runner or API call was created.

Selected smaller chunks: SPAN 1/overlap0/tile256/32; Vimeo 3/overlap1; GameUp 4/overlap2. They preserve each required context and reduce host retention; temporal tile fields are absent because they do nothing. Never set RRDB's overlap to catalog default2: it needs minimum3 for context7. This misleading default is documented, not fixed as an unrelated behavioral change.

### Framewise — PurePhoto SPAN — Clean Photography

```json
{
  "capability": "video.upscale",
  "nodeType": "local_video_upscale",
  "outputMediaType": "video",
  "modelId": "framewise/4x-purephoto-span",
  "providerModelId": "framewise/4x-purephoto-span",
  "provider": "local_video_upscale",
  "hostType": "boojumroute",
  "parameters": {
    "scale": 4,
    "device": "cuda",
    "output_codec": "libx264",
    "output_container": "mp4",
    "crf": 18,
    "chunk_size": 1,
    "overlap_frames": 0,
    "audio_handling": "copy",
    "tile_size": 256,
    "tile_overlap": 32
  },
  "inputs": [
    {
      "kind": "video",
      "role": "source",
      "index": 0,
      "assetId": "<id from existing asset import after approval>",
      "path": "Y:\\Процесс\\SnarkRoute\\apps\\server\\data\\h3-max-eval\\2026-09-27-controlled\\MAX-I1\\output.mp4"
    }
  ],
  "idempotencyKey": "video-upscale-MAX-I1-2026-09-30-framewise-4x-purephoto-span"
}
```

### VimeoScale Unet — Natural / CGI Video

```json
{
  "capability": "video.upscale",
  "nodeType": "local_video_upscale",
  "outputMediaType": "video",
  "modelId": "openmodeldb/vimeoscale-unet-x2",
  "providerModelId": "openmodeldb/vimeoscale-unet-x2",
  "provider": "local_video_upscale",
  "hostType": "boojumroute",
  "parameters": {
    "scale": 2,
    "device": "cuda",
    "output_codec": "libx264",
    "output_container": "mp4",
    "crf": 18,
    "chunk_size": 3,
    "overlap_frames": 1,
    "audio_handling": "copy"
  },
  "inputs": [
    {
      "kind": "video",
      "role": "source",
      "index": 0,
      "assetId": "<id from existing asset import after approval>",
      "path": "Y:\\Процесс\\SnarkRoute\\apps\\server\\data\\h3-max-eval\\2026-09-27-controlled\\MAX-I1\\output.mp4"
    }
  ],
  "idempotencyKey": "video-upscale-MAX-I1-2026-09-30-openmodeldb-vimeoscale-unet-x2"
}
```

### GameUpV2 TSCUNet Small — Compressed Game Video

```json
{
  "capability": "video.upscale",
  "nodeType": "local_video_upscale",
  "outputMediaType": "video",
  "modelId": "openmodeldb/gameup-v2-tscunet-small-x2",
  "providerModelId": "openmodeldb/gameup-v2-tscunet-small-x2",
  "provider": "local_video_upscale",
  "hostType": "boojumroute",
  "parameters": {
    "scale": 2,
    "device": "cuda",
    "output_codec": "libx264",
    "output_container": "mp4",
    "crf": 18,
    "chunk_size": 4,
    "overlap_frames": 2,
    "audio_handling": "copy"
  },
  "inputs": [
    {
      "kind": "video",
      "role": "source",
      "index": 0,
      "assetId": "<id from existing asset import after approval>",
      "path": "Y:\\Процесс\\SnarkRoute\\apps\\server\\data\\h3-max-eval\\2026-09-27-controlled\\MAX-I1\\output.mp4"
    }
  ],
  "idempotencyKey": "video-upscale-MAX-I1-2026-09-30-openmodeldb-gameup-v2-tscunet-small-x2"
}
```

## Future controlled comparison after approval

One identical MAX-I1 source; one run per explicitly approved candidate; no warmup, prompt, seed-dependent generative action or retries. Fix and log native scale, precision/device, tile/chunk/overlap, thread caps, source/color assumption and delivery encoding. One candidate at a time with resource sampling; stop for OOM, CPU interference or cancellation. Report failure rather than silently switch device or shrink settings and rerun.

Save native/output MP4, complete request/settings, model/source hashes, software versions, timestamps, output probe/SHA, video/audio lineage. Measure cold load, model inference, decode, preparation, resize, encode/mux, wall time, seconds processing per 5.166667-second video, peak allocated/reserved VRAM where possible, external GPU use with WDDM limits, RSS RAM/CPU for the process tree, file size. Current worker reports total/load/inference and allocated torch peak; separate decode/encode/RAM/CPU require future instrumentation, not invented telemetry.

Contact rows Original normalized baseline/Vimeo/SPAN/GameUp; columns 0/25/50/75/100%, frames 0/31/62/92/123. Same fit/padding for full frames. Native pixel crops at matched normalized regions: eyes/lashes/brows, lips/nose/jaw/hairline, hair strands, necklace/pendant/earrings, clothing edge, background stand/edge. Native and same-size crops answer different questions; label scale and avoid claiming native-size difference is quality.

Review whole normal-speed and slow playback for flicker, crawling, shimmer, edge wobble, texture boiling, eye/jewelry/hair/background mutation and chunk boundary seams. Compare identity, composition and original motion first. Then judge genuine edge/detail recovery versus halos/ringing, artificial pores/lashes/hair, plastic smoothing, denoise smearing and amplified compression. Sharpness is not automatically fidelity. No high-resolution ground truth exists; frame differences, edge/frequency measures, SSIM/LPIPS and scene-cut checks are supporting evidence only. Learned metrics also need separate resource permission. Human review decides suitability; no aggregate automatic winner.

## Checks, files and stop condition

- Six non-inference worker tests passed: registry parsing/uniqueness/pins/licenses, temporal context metadata, five-frame flattening/padding and edge repetition on tiny arrays. No model loading/execution.
- Two adapter tests passed with mocked fetch and dummy bytes: authenticated capability contract and upload/poll/download/provenance path, no worker/model execution.
- `pnpm --filter @snarkroute/local-video-upscale build` passed.
- Final JSON coherence checks validate installed/missing states, hashes, source, exact geometry, model scale/context/overlap, audio-copy plans, approval flags and absence of output videos.

Only this report and [preflight.json](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/preflight.json) are added. No runtime, model registry, UI or capability status was modified. README is stale (image-only claim); actual API/code show video support. Live catalog maps weight existence to available, not Verified; mock artificially marks installed, so file inventory is authoritative for this stage. Offline worker means live availability remains unavailable; existing small CUDA evidence is not MAX-I1 verification.

Initial preflight was NOT READY: worker offline, nominal free VRAM about 4.2 GiB at that snapshot, HD activation peaks unknown, and resource/color/isolation controls missing. The preparation below addresses implementation blockers. The user's separate approval and fresh live resource gates are still required. No next action executes a model automatically.

## RESOURCE-CONTROL PREPARATION

**READY FOR UPSCALE TEST: YES (implementation preparation). Execution approval: NO.** No model load, real torch/ORT import in the preparation tests, CUDA context, inference, warmup, one-frame check, download, normalization/baseline render, crop/contact sheet or comparison video was performed. Worker remains unstarted; actual model quality, backend success, VRAM peaks and present available VRAM remain unverified.

Future order: **Vimeo → PurePhoto SPAN → GameUp**. Temporal consistency, identity and motion take priority over useful detail and performance. No winner is selected. All three installed checkpoints are reused; missing/other models are excluded.

### CPU controls and isolation

Strict mode is opt-in with `LOCAL_VIDEO_BENCHMARK=1`; normal worker defaults remain unchanged. FFmpeg decoder input/output encoder each have explicit two-thread options; filter and complex-filter pools are capped at two, including Lanczos resize. Launch sets OMP/MKL/OPENBLAS/NUMEXPR/VECLIB limits to two before NumPy/ML imports. Before checkpoint loading PyTorch sets intra-op two, inter-op one. ORT sets intra-op two, inter-op one, sequential execution, with spinning disabled.

These are pool caps, not a promise of only two OS threads. To bound simultaneous heavy CPU work while decode and encode overlap, the worker starts with affinity to two allowed logical CPUs. A Windows Job Object enforces the same affinity for owned worker/FFmpeg/probe children and later normalization, with kill-on-close. Assignment/nested-job restrictions fail closed; cleanup does not enumerate or kill foreign processes. [Microsoft affinity/limit documentation](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information), [process assignment documentation](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

`controlled/active.lock` uses exclusive creation across processes; a second active harness fails. Persistent exclusive `controlled/<candidate>.attempt.json` prevents automatic retries even after BLOCKED/FAILED/OOM. Stale locks/attempt markers are never automatically cleared. Failed cleanup retains active.lock for manual review.

The worker accepts exactly one pinned candidate job per lifetime, including failed/cancelled attempts; image jobs are disabled. There is no candidate queue or loop. A fresh worker with an ephemeral private bearer token binds 127.0.0.1:8092, one Uvicorn worker, no reload. An occupied port blocks startup. Correct worker cwd, existing absolute model directory and isolated per-candidate data are passed explicitly. Python Settings reads environment, not dotenv; no new .env was created and root hosted-provider .env is not loaded.

Future lifecycle: prechecks → fresh worker → one job POST → collect native output/metrics → authenticated graceful shutdown → verify worker and child exit → normalize with the model process gone → metadata/AAC checks → cleanup. Caches cannot survive process exit. A hung job can terminate only the owned Job Object, without retry. Read-only GPU snapshots after exit/cleanup are saved; under WDDM and concurrent external workloads their change is not a precise model allocation measurement.

### Safety gates

Read-only nvidia-smi GPU0 query runs before worker startup, immediately before job submission and inside worker before model loading. Default required free VRAM is **8192 MiB**, configurable with `LOCAL_VIDEO_BENCHMARK_MIN_FREE_MIB`. Below it, report Current GPU / Used / Free / Required threshold and **BLOCKED**, starting no model and killing no external process. The old 4293 MiB snapshot was below this new gate; it is not a current measurement.

Future sampling approximately every 2 s covers owned process-tree CPU (100% = one logical CPU), total CPU, summed active RSS, available RAM, GPU utilization and system used/free VRAM. Job Object cumulative CPU includes exited children; first CPU sample is null until an interval exists. Defaults: process CPU >180% or total CPU >85% sustained 10 s; available RAM <4096 MiB; runtime free VRAM <512 MiB. `LOCAL_VIDEO_BENCHMARK_*` env thresholds are configurable and must be finite/positive. Measurement/resource failures stop the candidate; no device, tile or chunk adjustment/resubmit follows.

### Explicit color, geometry, codec and audio

**TEST ASSUMPTION, not measured source fact:** MAX-I1 is treated as SDR BT.709 limited-range YUV. Decode explicitly sets `in_color_matrix=bt709:in_range=tv:out_range=full` → RGB24 → float RGB [0,1] at model input. No gamma/contrast/saturation adjustment is added. Strict Vimeo rejects a luminance-only checkpoint.

Encode explicitly maps full RGB → limited BT.709 YUV420P, with primaries/trc/colorspace=bt709 and range=tv. Normalization pins RGB24 around Lanczos and padding so filter negotiation cannot introduce an earlier implicit YUV conversion. [FFmpeg scale documentation](https://ffmpeg.org/ffmpeg-filters.html#scale).

Native outputs are separate: Vimeo/GameUp 2688×1536, SPAN 5376×3072. Final content is Lanczos 2520×1440, black padding 20 px left/right → 2560×1440, SAR1; no crop/stretch. A source-baseline command uses the same color/final geometry/codec; it is plan-only, never automatically rendered. Any future baseline execution must use the same OwnedSession and CPU environment.

Common native/final profile: libx264, medium, CRF18, YUV420P, 24 fps, GOP48, minimum keyint48, scene-cut0, two threads, identical BT.709 tags. Native candidate encoding followed by final encoding retains an extra compression generation relative to the once-normalized source baseline. This residual bias is explicitly reported; native crops remain necessary. No silent lossless/CRF0 experiment is added.

Original AAC is separately timed stream-copy muxed into native output and copied from the source into normalized output. No -shortest, generation or audio re-encode. Future ffprobe hashes ordered encoded packet size/hash sequences and requires source/native/normalized identity. Output codec, frame count, dimensions, SAR, fps, color tags and AAC format are also checked. Payload identity does not prove perceptual sync; listening remains a later review step.

### CUDA-only and instrumentation

`device=cuda`; a failed PyTorch CUDA load/forward fails. Strict ORT requests only CUDAExecutionProvider and sets `session.disable_cpu_ep_fallback=1`, rejecting CPU graph placement at initialization. ORT 1.22 implicitly registers CPU EP even with this option: registration alone is not CPU node execution. CUDA registration is required, and completed node-provider profiling must exclusively show CUDA; CPU execution or missing evidence invalidates output before success. Even a small CPU graph partition can block this test. [ORT 1.22 initialization source](https://github.com/microsoft/onnxruntime/blob/v1.22.0/onnxruntime/core/session/inference_session.cc), [ORT threading documentation](https://onnxruntime.ai/docs/performance/tune-performance/threading.html).

The reviewed installed ORT Python constructor enables an internal EP retry before returning, so calling disable_fallback only afterwards would be insufficient. A narrow subclass hook disables it **before the first session creation**, and runtime fallback is disabled too. This private API adapter is explicitly pinned to ORT 1.22.0; another version fails before loading rather than silently losing the no-retry guarantee. Mock tests prove a CUDA constructor failure gets one attempt and no CPU re-creation. Backend/profile diagnostics are retained. [ORT 1.22 Python constructor source](https://github.com/microsoft/onnxruntime/blob/v1.22.0/onnxruntime/python/onnxruntime_inference_collection.py).

Prepared timings: startup, model load, decode pipe-read wait, runtime preprocessing, synchronized CUDA forward, runtime postprocessing, encode pipe-write wait, encoder-finalization wait, native audio mux, combined final resize/normalization/encode and total wall. ORT session.run includes copies. Streaming codecs overlap inference: pipe waits are not isolated codec compute durations and are not additive to wall; final FFmpeg resize/encode is honestly a combined stage.

PyTorch peaks include allocated and reserved memory. Torch peaks do not represent ORT allocations: ORT uses provider profiling plus explicitly labeled system GPU sampling with WDDM attribution limits. Resource samples cover startup/job/worker exit/normalization, including process-tree RSS/CPU, total CPU, available RAM and output sizes. No current inference metrics were collected.

Actual chunk output/window ranges, left/right context and clip-edge repeat policy are recorded. Vimeo context3, GameUp context5; SPAN boundaries carry no temporal model meaning. Future comparison rows: Source normalized baseline / Vimeo / SPAN / GameUp; frames 0,31,62,92,123. Native crops: eyes/brows/lashes, nose/lips/jaw, hair, pendant/earring, black blouse edge, background stand. Full-speed review first, then slow; identity, temporal consistency, motion, artifacts and useful detail precede sharpness. No review media is generated now.

Licenses stay visible: Vimeo and PurePhoto **CC-BY-SA-4.0**; GameUp **CC-BY-NC-SA-4.0, NON-COMMERCIAL restriction**. GameUp remains a research candidate.

### Exact safe future launch — NOT EXECUTED

Use the harness, which sets child cwd/env, affinity, token and session containment. Its default mode writes a plan; execution requires matching approval flags after the separate human message.

```powershell
Set-Location -LiteralPath 'Y:\Процесс\SnarkRoute\workers\local-upscale'
# Only after the separate message “Запускай Vimeo”:
& .\.venv\Scripts\python.exe .\scripts\run_video_bakeoff.py --candidate vimeo --execute --approve-candidate vimeo
```

SPAN/GameUp each need their own later approval; never execute a candidate loop. The future child command is `.venv/Scripts/python.exe -m app.benchmark_worker --port 8092` with the prepared explicit environment and one localhost Uvicorn worker. Run the harness rather than launching the child manually.

Complete launch environments and native/final/baseline commands: [Vimeo plan](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/vimeo-prepared.json), [SPAN plan](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/span-prepared.json), [GameUp plan](Y:/Процесс/SnarkRoute/apps/server/data/video-upscale-eval/2026-09-30/gameup-prepared.json). These are preparation artifacts, not submissions.

Exact future bodies for POST `/v1/video/jobs`; input_asset is filled once from the uploaded MAX-I1 asset:

```json
{
  "model": "openmodeldb/vimeoscale-unet-x2", "input_asset": "<uploaded MAX-I1 asset>",
  "scale": 2, "device": "cuda", "chunk_size": 3, "overlap_frames": 1,
  "tile_size": 256, "tile_overlap": 32, "output_codec": "libx264",
  "output_container": "mp4", "crf": 18, "audio_handling": "copy"
}
```

```json
{
  "model": "framewise/4x-purephoto-span", "input_asset": "<uploaded MAX-I1 asset>",
  "scale": 4, "device": "cuda", "chunk_size": 1, "overlap_frames": 0,
  "tile_size": 256, "tile_overlap": 32, "output_codec": "libx264",
  "output_container": "mp4", "crf": 18, "audio_handling": "copy"
}
```

```json
{
  "model": "openmodeldb/gameup-v2-tscunet-small-x2", "input_asset": "<uploaded MAX-I1 asset>",
  "scale": 2, "device": "cuda", "chunk_size": 4, "overlap_frames": 2,
  "tile_size": 256, "tile_overlap": 32, "output_codec": "libx264",
  "output_container": "mp4", "crf": 18, "audio_handling": "copy"
}
```

Temporal tile values are serialized for a fully pinned request but unused; there is no temporal spatial tiling. No request was submitted.

### Focused verification and readiness limits

30 Python pure/mock tests passed: config/launch/thread caps, mocked real pipeline command hooks, color/profile/normalization math, audio-copy and packet hashes, active/permanent attempt locks, one-job service, exact serialization, GPU parser/BLOCKED-no-start/no-retry, sustained CPU guard, fake Windows ownership/affinity/cleanup/telemetry, strict mocked ORT sessions/profile/constructor-no-retry and fake torch pool configuration. Tests verify real torch/onnxruntime are absent from sys.modules; no worker was started.

2 adapter mock tests and `pnpm --filter @snarkroute/local-video-upscale build` passed. AST syntax checks passed for 10 changed/new Python files without executing them; focused git diff whitespace checks passed. Incremental AST-only graph update completed (no LLM/API cost). No dependencies were added, full-project test/build or real model smoke test ran.

**READY FOR UPSCALE TEST: YES — implementation preparation.** This is not evidence of live CUDA success, adequate current VRAM, model quality or real shutdown behavior. Future resource/backend failures remain BLOCKED/FAILED, without retry. Stop and await **“Запускай Vimeo”** or explicit approval of another named candidate.


## Approved Vimeo execution — 2026-10-01

Preparation readiness above is historical. Vimeo native CUDA job succeeded, but full harness FAILED at shutdown verification before normalization; independent native metadata validation also failed (exact fields in verification JSON). Original AAC packet identity verified. No retry or other candidate. Final owned process exit confirmed; details in [controlled run report](Y:/Процесс/SnarkRoute/docs/research/vimeo-controlled-run-2026-10-01.md). Current next-test readiness is NO pending diagnosis and separate user instruction.
