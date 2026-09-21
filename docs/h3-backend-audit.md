# H3 backend audit

Status: 2026-09-09. This document describes the checked-in SnarkRoute implementation. MATLOWAI T2VA and first-frame FL2VA preview have now completed on the real RTX 3080 Laptop GPU. It does not claim that VDN-H3, last-frame FL2VA, Ref2VA, native audio or final-quality MATLOWAI generation works.

## What is actually wired today

There are two active request paths, not one literal `SnarkRoute -> Model Gateway -> worker` chain:

1. H3 Studio: `apps/studio/src/features/h3/*` -> `/api/h3/*` -> `H3QueueService` -> `H3SessionRuntime` -> `createH3WorkerClient()` -> H3 worker.
2. Route execution: built-in node `minimax.h3.generate` -> `createH3NodeRunner()` -> `createH3WorkerClient()` -> H3 worker.

The generic Model Gateway job service can construct and execute routes, but H3 is not currently a complete Model Gateway model registration: `minimax.h3.generate` is absent from its supported-runner validation and `GatewayModelResolver` has no H3 model entry. The special `provider === "minimax-h3"` progress-stage handling therefore does not by itself make H3 executable through that generic gateway. `createH3ProviderAdapter()` exists in `@snarkroute/h3`, but no production registration currently consumes it.

The stable boundary that both active paths already share is the H3 worker HTTP API. Runtime selection therefore belongs behind that API:

```text
SnarkRoute H3 caller
  -> @snarkroute/h3 client and request serializer
  -> authenticated H3 worker HTTP API
  -> Backend protocol
       -> SGLangBackend (working implementation)
       -> MatlowInt8Backend (local headless Comfy core adapter; T2VA/FL2VA preview MVP)
       -> VDNBackend (fail-closed scaffold)
       -> DiffusersBackend (fail-closed scaffold)
       -> MockBackend (contract tests only)
  -> local or S3 result store
  -> worker result/content response
```

## Code map

- Provider and node registration: `apps/server/src/providers/provider-node-manifests.ts`, `apps/server/src/execution/service.ts`.
- Shared H3 request/client/runner: `packages/adapters/h3/src/index.ts` and `packages/adapters/h3/test/h3.test.ts`.
- Generic Model Gateway boundary: `packages/core/src/model-gateway/index.ts`, `apps/server/src/model-gateway-jobs/service.ts`, `apps/server/src/execution/model-gateway-runners.ts`.
- H3 Studio UI and shell entry: `apps/studio/src/features/h3/*`, `apps/studio/src/main.tsx`, `apps/snarkroute/src/main.tsx`, and the H3 icon assets under both applications' `public` directories.
- H3 Studio server API and connection state: `apps/server/src/routes/h3.ts`, `apps/server/src/services/h3-connection.ts`.
- Queue, session, Vast provisioning and tunnel: `apps/server/src/services/h3-queue.ts`, `h3-session-runtime.ts`, `h3-vast-template.ts`, `h3-ssh-tunnel.ts` and their focused tests.
- Worker API and jobs: `workers/minimax-h3/app/main.py`, `models.py`, `config.py`, and `app/storage/jobs.py`.
- Runtime boundary: `workers/minimax-h3/app/backends/base.py`, `factory.py`, `sglang.py`, `vdn.py`, `diffusers.py`, `mock.py`.
- Result storage: `workers/minimax-h3/app/storage/results.py`; outputs can be local or S3, while resumable job JSON remains local.
- Worker launch and SGLang installation: `workers/minimax-h3/Dockerfile*`, `compose.example.yml`, `requirements.sglang.txt`, `scripts/sglang_entrypoint.py`, `bootstrap_vast_fl2va.sh`, and the local WSL start/stop/download scripts.
- SGLang/CUDA safeguards and benchmarks: `scripts/kitchen_selftest.py`, `benchmark.py`, the pinned model manifest, precision-profile tests and runbooks.
- Hosted MiniMax 2K regeneration: `packages/adapters/h3/src/index.ts`, `apps/server/src/h3-regeneration/service.ts`, and `apps/server/src/routes/tool-jobs.ts`. This is a separate provider API flow, not an inference backend of the self-hosted worker.
- Runtime data under `apps/server/data/h3-studio/` is user state/output, not implementation code.

## Worker HTTP contract

The API remains unchanged. `GET /health` is the only unauthenticated endpoint. All `/ready` and `/v1/*` calls require `Authorization: Bearer <H3_WORKER_SERVICE_TOKEN>`.

| Method and path | Contract |
| --- | --- |
| `GET /health` | Process liveness only; does not assert model/GPU readiness. |
| `GET /ready` | `200` when selected backend is ready, otherwise `503`; includes backend name/version, reason, active job count. |
| `GET /v1/capabilities` | Selected backend and an availability/reason entry for each capability. |
| `POST /v1/assets` | Raw PNG, JPEG, MP4, WAV or MP3 body; returns a worker-local asset URI. Size, MIME and magic bytes are checked. |
| `POST /v1/jobs` | Validated `GenerateRequest`; returns `202` and a job. Supports `Idempotency-Key` header or body field. |
| `GET /v1/jobs/{id}` | Status, stage, progress, structured error, outputs and metadata. |
| `POST /v1/jobs/{id}/cancel` | Marks a non-terminal worker job cancelled and cancels its local asyncio task. |
| `GET /v1/jobs/{id}/result` | Output descriptors and metadata after success. |
| `GET /v1/jobs/{id}/content?variant=N` | MP4 bytes or a redirect from the selected result store. |

Job states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. The worker enforces request/upload/input limits, per-job timeout and result/temp retention. S3 stores output objects only; job state is persisted locally.

Backend cancellation is currently cooperative: the worker cancels its task, but `SGLangBackend` does not call an upstream SGLang cancellation endpoint. A VDN implementation must define and test process/request termination so GPU work cannot continue invisibly after the worker job is cancelled.

## Input-mode matrix

| Mode | Current SnarkRoute API | Current SGLang mapping | VDN backend must implement and verify |
| --- | --- | --- | --- |
| T2VA | `task=t2va`, prompt + target, no conditions | Sent to the configured FL2VA SGLang service as `task=t2va` | Prompt encoding, audio/video generation, seed/steps/output semantics and result muxing. This is the only generation shape demonstrated by the current official OpenVDN quick start. |
| I2V / first frame | `task=fl2va`, one image condition with `role=keyframe`, `frame_index=0` | FL2VA service | Exact first-frame conditioning support and accepted image format. It is not a separate worker task today. |
| FL2VA | `task=fl2va`, zero, first, last, or both keyframe images (`frame_index=0/-1`) | FL2VA service | First/last-frame conditioning, validation limits and behavior with only a last frame. |
| Ref2VA image | `task=ref2va`, image condition(s), `role=reference` | Ref2VA service | Image-reference encoding, limits, ordering and semantic fidelity. |
| Image + audio reference | `task=ref2va`, separate image and audio conditions | Ref2VA service | Audio encoding, synchronization, supported codecs/durations and mixed-reference ordering. |
| Video reference | `task=ref2va`, `type=video` or `video_audio`, optional `start_time_seconds` | Ref2VA service | Video/audio extraction, time-offset semantics, codecs, limits and whether source audio is required/preserved. |

The route node UI exposes separate first-frame, last-frame, image, video and audio inputs. `video_audio` is representable by the TypeScript adapter through `requireVideoAudio`, but normal node input conversion currently drops that flag. Audio-only references are deliberately rejected. H3 Studio maps first/last-frame work to `fl2va` and motion/style/reference work to `ref2va`; object replacement, automatic tracking and 2K resampling are not capabilities of the current self-hosted SGLang worker.

## Runtime separation and configuration

`Backend` already provided the correct abstraction (`capabilities`, `ready`, `execute`). The refactor keeps that abstraction and makes two minimal changes:

- `GenerateRequest` is now backend-neutral. Construction of the upstream `/v1/videos` payload lives in `SGLangBackend`'s module.
- `H3_BACKEND=vdn` selects a concrete `VDNBackend` scaffold. It reports not ready and all capabilities unavailable. Unknown backend names now fail at configuration/factory creation instead of silently selecting the mock backend.

No VDN package, checkpoint or API dependency was added. The official OpenVDN repository currently documents a Python/CLI pipeline, patched Diffusers, PyTorch 2.13 + CUDA 12.9, FlashAttention 4 and local output; it does not document a worker-compatible HTTP job contract. The scaffold therefore has no invented URL, payload, polling or cancellation scheme.

SGLang-specific configuration remains intentionally isolated and backward compatible: `SGLANG_FL2VA_URL`, `SGLANG_REF2VA_URL` and `H3_SGLANG_PRECISION_PROFILE`. The existing SGLang commit, model revision, `kitchen_int8` code, CUDA kernel self-test and BF16 profile are untouched.

## MATLOWAI local backend

`H3_BACKEND=matlow_int8` reuses the same worker HTTP contract and result storage. The adapter imports ComfyUI core `f938505952476e48a12687eac696cdc94d48a3fe` as a Python library because the checkpoint is a single-file `comfy_quant` model. No ComfyUI process, server, GUI, frontend package, public node graph, or public workflow JSON is used. The first backend milestone calls the core loaders, H3 conditioner, `res_multistep` sampler, VAE decoder and video writer directly.

`local_fast` is intentionally fail-closed: 960x544 at 16:9, 124 frames for a requested five seconds, four denoise steps, fused Turbo weights, dense attention, DynamicVRAM, 256/64 VAE tiles and native audio disabled. `final`, last-frame FL2VA, Ref2VA and `local_quality` remain unavailable until separately exercised. Startup checks the exact ComfyUI and `comfy-kitchen==0.2.31` versions and executes a real ConvRot `int8_linear` operation. T2VA and first-frame FL2VA both completed on RTX 3080 Laptop (compute capability 8.6, PyTorch 2.13.0+cu130, CUDA 13.0), with valid H.264 MP4 output and zero swap growth. The measured runs are recorded in `docs/runbooks/minimax-h3-local-wsl.md`.

The four pinned model files total 40,444,247,247 bytes (37.67 GiB). They cannot be hard-linked to the existing Diffusers/SGLang shards because the quantized single-file layouts and checksums differ. All revisions, byte counts and SHA-256 values are in `workers/minimax-h3/model-manifest.yaml`.

Reviewed versions and upstream state:

- SnarkRoute H3 worker API: `0.2.0`.
- MiniMax H3 model revision: `42ed227ee7df40d41602854ae760620d6eb651fe`.
- Current pinned SGLang commit: `0bcd822377da7b5718e674eaf9c870d349424dd1`.
- Optional CUDA/SGLang `comfy-kitchen`: `0.2.31`; it was not removed or changed here.
- OpenVDN package metadata: `vdn==0.1.0`; reviewed `main` commit `b8cb28fbfca0266d1c7742a9f25ab8b58191de97`. This is audit evidence, not yet a SnarkRoute runtime pin or installed dependency.

## External VDN validation TODO

Before marking even one VDN capability available:

1. Pin a tested OpenVDN commit and separately review/accept the model-weight license.
2. Capture the real external deployment command, supported GPU architectures, VRAM/RAM/disk use, kernel compile/cache behavior and cold-start time.
3. Decide the transport from evidence: a supervised local process adapter or a separately implemented HTTP service. Record its exact request, status, progress, cancellation and result contract.
4. Prove VDN T2VA on a real GPU, including deterministic seed expectations, MP4 audio/video, timeout and cancellation cleanup.
5. Test each additional VDN mode independently. Do not infer FL2VA/Ref2VA support from MiniMax H3 compatibility.
6. Add backend-specific integration tests and a deployment profile. Managed Vast provisioning is currently SGLang-specific; an external saved-worker URL is backend-neutral.
7. Add provenance fields for the pinned VDN commit/checkpoint and actual precision/kernel choices without changing the public job schema.

## Architectural issues and severity

- External VDN is **not blocked** if it implements the existing worker API: H3 Studio and the route runner already treat the worker as a backend-neutral service.
- Generic Model Gateway integration is incomplete. H3 lacks resolver/runner registration and the existing `createH3ProviderAdapter()` is unused. This should be a separate compatibility change with focused gateway tests; it is not required for H3 Studio.
- Cancellation does not propagate all the way in every path. The TypeScript client supports worker cancellation, but `createH3NodeRunner()` does not connect the executor abort signal to it, H3 Studio queue has no item/session cancel call, and SGLang has no explicit upstream cancel request.
- Managed Vast bootstrap/template code assumes SGLang and `kitchen_int8`. Backend-specific deployment profiles will be needed once VDN's measured requirements are known.
- Common `Settings` still contains SGLang fields for every backend. This is harmless today and avoids needless config migration; split settings only when a real VDN adapter introduces validated options.

## Primary sources reviewed

- [OpenVDN VDN-Minimax-H3 repository and quick start](https://github.com/OpenVDN/vdn-minimax-h3)
- [OpenVDN Python package metadata](https://github.com/OpenVDN/vdn-minimax-h3/blob/main/pyproject.toml)
- [OpenVDN single-GPU 8-NFE FP8 configuration](https://github.com/OpenVDN/vdn-minimax-h3/blob/main/configs/inference/8nfe_tuned_fp8.yaml)
- [MATLOWAI fused Turbo INT8 ConvRot model card](https://huggingface.co/MATLOWAI/minimax-h3-fused-turbo-int8-convrot)
- [Pinned ComfyUI core requirements](https://raw.githubusercontent.com/Comfy-Org/ComfyUI/f938505952476e48a12687eac696cdc94d48a3fe/requirements.txt)
- [Comfy-Org MiniMax H3 single-file components](https://huggingface.co/Comfy-Org/MiniMax-H3)
- [Kijai INT8 ConvRot video VAE](https://huggingface.co/Kijai/MiniMax-H3-experimental/blob/f4cac997f880e93cf6940af61ee8d58ef31ff7f3/minimax_h3_video_vae_int8_convrot.safetensors)
