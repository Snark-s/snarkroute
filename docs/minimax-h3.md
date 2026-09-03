# MiniMax H3 first deployment

Status: `kitchen_int8` startup and a 20-step 1344×768 end-to-end T2VA functional benchmark were verified on a rented modified RTX 4090 48 GB on 2026-08-30. The test confirms CUDA kernels, online weight quantization, API readiness, MP4 creation, and audio/video streams on that machine; it is not a blind quality benchmark and does not validate an ordinary 24 GB RTX 4090 or TP2.

## Decision and boundaries

```text
SnarkRoute Model Gateway
  -> @snarkroute/h3 (provider adapter)
  -> authenticated workers/minimax-h3 API
  -> replaceable backend (mock | SGLang | future Diffusers/custom)
  -> GPU inference
  -> local or S3-compatible result storage
  -> unchanged SnarkRoute result endpoint
```

ComfyUI is excluded from production: no runtime, API server, container, or custom node. The separately reviewed `comfy-kitchen` package is a CUDA/PyTorch kernel extension, not ComfyUI. It is optional, pinned, and isolated to the CUDA/SGLang image; the API image does not install it. The public worker contract does not expose backend-specific objects. Existing SnarkRoute endpoints remain compatible:

- `POST /api/model-gateway/jobs`
- `GET /api/model-gateway/jobs/:id`
- `GET /api/model-gateway/jobs/:id/result`

The worker uses `queued/running/succeeded/failed/cancelled`, progress, stages, structured errors, request/header idempotency, cancellation, per-job timeout, persistent job records, safe temporary directories and result metadata. The TypeScript adapter accepts the new canonical `succeeded` plus legacy `completed` during migration.

## What official sources confirm

Pinned model: `MiniMaxAI/MiniMax-H3@42ed227ee7df40d41602854ae760620d6eb651fe`, MiniMax H3 Community License Agreement. The repository is not gated, but operators must review/accept the license and any territorial/commercial conditions themselves.

SGLang `0.5.17` does **not** contain `kitchen_int8`. The CUDA image therefore pins the reviewed post-release source commit `3f26febaff04bac4cfefd60bdc9097bc26a96cb8` (the feature landed in `63d783bbe0955237ec41f9ddabf7235ddf04673c`), with PyTorch `2.13.0`, Diffusers `0.37.0`, and CUDA base `13.0.1`. It supports H3 FL2VA/Ref2VA through asynchronous `/v1/videos`.

`comfy-kitchen==0.2.31` is pinned to the Linux CPython 3.12 ABI3 wheel SHA-256 `d7c2522e6a6cde7a7303e30d739c05989cf4b0a246684e496a129b950055d35f` (58,541,121 bytes). Its wheel metadata has no mandatory `Requires-Dist` entries. The uninstalled optional extras are `cublas` (`nvidia-cublas>=13.0.0`), `dev`, and `build`; the image deliberately installs the base wheel with `--no-deps`, so it adds no transitive Python packages. The library uses PyTorch at runtime, supplied by SGLang's pinned `torch==2.13.0`. Wheel-content inspection found only the `comfy_kitchen` package/native extension and metadata, with no ComfyUI, server, web runtime, nodes, or `custom_nodes` tree.

The official cookbook documents one RTX 4090 24 GB with online, data-free `kitchen_int8`, exact FlashAttention, and layerwise offload of `dit,text_encoder`; that is the recommended single-card command. It also documents the same offload command without `--quantization` as the BF16 baseline. Its 2×RTX 5090 TP2 recipe is lossless BF16 and neither requires nor recommends `kitchen_int8`. The cookbook reports about 18 GB peak VRAM for both single-card BF16 and INT8. At 1344×768, 107 frames and 20 denoiser evaluations, its RTX 4090 benchmark reports BF16 405.6 s end-to-end / 370.2 s denoise and `kitchen_int8` 303.3 s / 273.7 s (1.34× end-to-end, PSNR 24.81 against BF16). Those upstream measurements do not prove this image on a rented GPU.

Pinned Diffusers integration: merged commit `f53d552036a0d1bd5570782a39cd40cfabf112bc`. It is a Modular Pipeline integration. This repository reserves a backend adapter but does not claim it as runnable until a GPU implementation is tested.

Confirmed open H3-Base behavior: 4–15 seconds, 24 fps, 768-pixel short edge, synchronized 32 kHz stereo audio. FL2VA supports text plus zero/one/two endpoint images. Ref2VA supports up to nine images, three videos, three audio files, twelve files total. H3-Regenerate-2K is not open-sourced and remains a separate hosted next-stage service already represented by `apps/server/src/h3-regeneration`.

Primary references:

- [MiniMax model card](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [Pinned SGLang H3 cookbook](https://github.com/sgl-project/sglang/blob/3f26febaff04bac4cfefd60bdc9097bc26a96cb8/docs/cookbook/diffusion/MiniMax/MiniMax-H3.mdx)
- [Pinned SGLang kitchen_int8 implementation](https://github.com/sgl-project/sglang/blob/3f26febaff04bac4cfefd60bdc9097bc26a96cb8/python/sglang/multimodal_gen/runtime/layers/quantization/kitchen_int8.py)
- [comfy-kitchen package metadata](https://pypi.org/project/comfy-kitchen/0.2.31/)
- [Diffusers MiniMax H3 merge](https://github.com/huggingface/diffusers/pull/14355)
- [RunPod current GPU catalog](https://www.runpod.io/gpu-models)
- [Vast offer-search fields](https://docs.vast.ai/cli/reference/search-instances)

## Capabilities

| Capability | State | Notes |
|---|---|---|
| `fl2va` | implemented contract; SGLang-supported | Text-only `t2va` tested at 20 steps and 1344×768 on a modified 48 GB RTX 4090; first/last-frame conditioning remains untested. |
| `ref2va` | implemented contract; SGLang-supported | Semantic/motion/audio references, not pixel-aligned editing. GPU unverified here. |
| `preview` | implemented, 4–10 sigma steps | Base preview works without hidden acceleration. Turbo LoRA is optional but disabled until its revision/checksum/license are resolvable. |
| `final` | implemented, 20–40 sigma steps | No hidden LoRA/cache acceleration. |
| `kitchen_int8` | optional CUDA/SGLang capability | Fail-closed CUDA test and 20-step end-to-end T2VA verified on a modified 48 GB RTX 4090; ordinary 24 GB and TP2 remain unverified. |
| `video_inpaint` | contract/validation only | Returns `capability_not_available`; neither pinned backend exposes the required native noise-mask workflow. |
| `automatic_tracking` | adapter boundary only | A ready mask video is the intended first working path. No SAM3 claim. |
| `resample` | contract only | Hosted H3-Regenerate-2K is separate; open local weights are unavailable. |

## Latent video inpainting design

`video.inpaint.h3` accepts `source_video`, `mask` or `selected_subject`, `reference_image`, `prompt`, `audio_mode`, `crop_padding`, `denoise`, `steps`, `seed`, and `quality`. The isolated target chain is:

```text
decode -> track/load mask -> temporally stable crop -> encode latents
       -> masked H3 sampling -> feathered composite -> audio mux
```

The reusable algorithmic principles are documented without importing source/runtime code: snap binary masks to H3's 2×2 latent token grid; align temporal masks with the causal VAE grouping; plan crop position/size across the whole clip so segmentation jitter does not become camera motion; composite the processed crop back with a stable feather; map audio masks to complete audio latent frames. Sources studied: [per-token H3 mask PR](https://github.com/Comfy-Org/ComfyUI/pull/15375) and [MaskVidExperiments design notes](https://github.com/drozbay/MaskVidExperiments). Their ComfyUI/GPL implementations are not copied or depended on.

## Storage and security

The worker keeps `/models`, `/data/tmp`, and `/data/results` separate. Job JSON is persisted atomically. Local results require a persistent mounted volume; `H3_STORAGE_BACKEND=s3` enables the lazy Boto3 S3-compatible adapter without requiring a real bucket for local tests. S3 credentials stay in environment/provider secrets. Temporary work is removed on completion and stale temp directories are cleaned at startup.

Only `/health` is public and contains no backend/media detail. `/ready` and `/v1/*` use constant-time bearer-token verification. SGLang ports must remain private. Uploads accept only PNG/JPEG/MP4/WAV/MP3, check signatures and sizes, generate server-side names, and reject traversal/private literal URLs. Remote URL egress must also be restricted at the container/network layer to prevent DNS-rebinding SSRF. Prompts, media and tokens are not logged.

Defaults: 100 MiB per upload, 500 MiB combined local input, 2 MiB JSON request, 4–15 second duration, 12 references, 10 outputs. Result retention is an operator policy; persistent results are not mixed with temporary files or model weights.

## Model volume and consumer GPU decision

The pinned original FL2VA partition is `144,051,185,561` bytes including the root index (about 134.16 GiB); Ref2VA is the same size. Provision at least 250 GB for one partition and operating margin, or 450 GB if both partitions and normal caches/results will coexist. Do not run an unscoped `hf download`: the full repository includes duplicate original partitions and a ~195.92 GiB Diffusers-format root.

The safest first repeat rental is one modified RTX 4090 with 48 GB VRAM, at least 256 GiB usable container RAM, and 300 GB disk, with the explicit `kitchen_int8` profile. On the tested machine, SGLang quantized 209 linear layers from 37.38 GiB BF16 to 18.69 GiB INT8. A 20-step, 1344×768, 4.458-second T2VA request completed in 259.71 seconds and reported 18,788 MB peak VRAM; startup briefly reached about 30,422 MiB. Cgroup memory peaked at 265,707,483,136 bytes (247.46 GiB), current model-server memory was about 171.94 GiB, the model occupied 135 GiB on disk, and the isolated SGLang environment occupied 9.6 GiB. Therefore 192 GiB RAM and an ordinary 24 GB card are no longer the project's safe first-rental recommendation even though the official cookbook reports a successful 24 GB recipe. Keep 250 GB as a tight disk floor only for a prebuilt image and small outputs; use 300 GB for the first deployment.

Provider choice is secondary to usable host RAM and actual VRAM. A verified Vast offer exposing a 48 GB modified RTX 4090 (or another 48 GB CUDA-13-capable GPU), `cpu_ram>=256`, `disk_space>=300`, and driver `>=580` is the most realistic first repeat target. Do not infer 48 GB from the product name: verify `nvidia-smi` after boot. An ordinary 24 GB RTX 4090 remains a follow-up compatibility test, not the first recommendation.

Keep `bf16_offload` as the lossless comparison profile on the same card. The official 2×RTX 5090 32 GB TP2 recipe remains the faster lossless alternative and requires a 384 GiB-class host (official validation used 377 GiB). `kitchen_int8` quantizes eligible DiT linear weights online; unsupported layers remaining BF16 are reported by SGLang. If the package or CUDA kernel self-test fails, startup stops and prints the error—there is no automatic BF16 fallback.

## First server launch

H3 Studio can create its own private Vast template and run the complete managed path without Jupyter or manual terminal commands. The template pins source revision `a5e3a57c0806ee10d719f0631eee7fb61f51124c` and `vastai/pytorch:2.13.0-cu130-cuda-13.2-mini-py312-2026-09-01`, injects secrets only when creating an instance, runs the fail-closed bootstrap, and exposes the localhost-only worker through a SnarkRoute-owned SSH tunnel. See `docs/runbooks/minimax-h3-vast.md` for the one-time UI setup and manual fallback.

The commands below remain the provider-neutral manual path.

From `workers/minimax-h3`, after checking the current provider price and setting provider-side auto-stop:

```bash
export H3_WORKER_SERVICE_TOKEN="$(openssl rand -hex 32)"
export HF_TOKEN="<provider-secret>"
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --dry-run
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --accept-license
uv run python scripts/verify_models.py --component h3-base-fl2va --model-dir /models --checksums
docker compose -f compose.example.yml --profile gpu-int8 build
H3_MODEL_DIR=/models H3_BACKEND=sglang H3_ENABLED_VARIANTS=fl2va \
H3_SGLANG_PRECISION_PROFILE=kitchen_int8 \
SGLANG_FL2VA_URL=http://h3-fl2va-int8:30010 \
docker compose -f compose.example.yml --profile gpu-int8 up -d
python scripts/smoke_test.py --url http://127.0.0.1:8080 --require-gpu
```

The `gpu-int8` profile is the official one-card topology. The CUDA entrypoint runs a small BF16→INT8 quantization plus fused `int8_linear` CUDA operation before SGLang starts. This proves kernel load/execution only; the smoke test and benchmark must still prove end-to-end H3 on the rented card. Use `gpu`/`gpu-bf16` for the 2×5090 lossless topology.

## Benchmark and H3 vs Kling

Five fixed cases and blind-review rules are in `workers/minimax-h3/examples/ab-h3-vs-kling.json`. Use identical owned prompts/references, record all attempts, score motion/identity/prompt adherence/artifacts 1–5 before revealing the system, and keep rejected outputs in the count. Record current hourly price as an input, never a code constant:

```bash
python scripts/benchmark.py --case-id ab-01 --system h3 \
  --profile kitchen_int8 --gpu-model "RTX 4090" \
  --gpu-usd-per-hour "$GPU_USD_PER_HOUR" --startup-seconds 0 \
  --model-load-seconds 0 --render-seconds 0 --attempts 1 --accepted-results 0 \
  --model-parameters '{"backend":"sglang","steps":30,"seed":1101}'
```

Run the identical case again with `--profile bf16_offload`. Add `--verified-on-gpu` only to records produced on real hardware. JSON and CSV contain the precision profile, verification flag, GPU model, peak VRAM, host RAM, disk, price, startup/load/render time, attempts, accepted results, costs, parameters, and subjective scores.

## Rollback and unresolved items

Rollback: stop the facade/backend, point `H3_WORKER_URL` back to the previous worker, retain the old image/model volume until a result download is verified, then remove only the named new containers/images. Jobs interrupted by restart become retryable `worker_restarted` failures; existing SnarkRoute provider contracts remain unchanged.

Open risks: real kernel compatibility and end-to-end INT8 load/inference on the rented Ada GPU; actual peak VRAM/RAM, latency and output quality against BF16; driver r580+/CUDA 13 compatibility; very high host RAM/I/O; Ref2VA on offload topologies; remote media egress/DNS policy; upstream cancellation propagation; S3 multipart/large-result testing; model/LoRA licenses; no native inpaint; no automatic tracker; hosted 2K API/pricing; provider auto-stop correctness.
