# Local H3 Regenerate / Resample 2K — research, 2026-09-30

## Decision

**Case C. Local Regenerate 2K = UNAVAILABLE / NOT PUBLISHED / NOT FOUND. READY FOR HEAVY TEST: NO.**

No downloadable implementation matching native H3-Regenerate-2K was found in the inspected official distribution, first-party Comfy code, or the community candidate below. This is a dated finding, not proof that no private or future implementation can exist. No inference, new weights, conversion, quantization, GPU probe, offload experiment, ffmpeg analysis, paid call, or render was performed.

Official MiniMax describes regeneration as feeding the Base result and original context back into H3. It explicitly says the module is not open-sourced. This is distinct from pixel upscale, restoration, Ref2VA video conditioning, and ordinary generation at a larger resolution. The official Full 2K scripts combine local Base with a remote regeneration request. [Pinned official README](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/README.md), [pinned regeneration script](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/scripts/readme/full-2k-t2va-h3-regenerate-2k.sh).

## Sources and exact revisions

| Source | Ownership / revision | Finding |
|---|---|---|
| [MiniMax-AI/MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3/tree/d21241f0a4b3acbb34c97dae47fa417b7065e438) | Official; `d21241f0a4b3acbb34c97dae47fa417b7065e438` | Documentation and hosted Full 2K scripts; no released local regeneration path |
| [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/tree/42ed227ee7df40d41602854ae760620d6eb651fe) | Official; `42ed227ee7df40d41602854ae760620d6eb651fe` | Same revision as local manifest; FL2VA and Ref2VA task families |
| [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3/tree/e5eb578a89295337b8ff433a035929ce0279e0b6) | First-party Comfy distribution; `e5eb578a89295337b8ff433a035929ce0279e0b6` | 37 entries in metadata; no regenerate/resample/2K weight entry |
| [ComfyUI API node](https://github.com/Comfy-Org/ComfyUI/blob/8cfe5e1ecb97512dea8deaac15e1228d7e6feeb1/comfy_api_nodes/nodes_minimax.py) | First-party; `8cfe5e1ecb97512dea8deaac15e1228d7e6feeb1` | Regenerate to 2K is an authenticated partner API node |
| [Pinned local Comfy nodes](https://github.com/Comfy-Org/ComfyUI/blob/f938505952476e48a12687eac696cdc94d48a3fe/comfy_extras/nodes_minimax_h3.py) | First-party; worker pin `f938505952476e48a12687eac696cdc94d48a3fe` | ImageToVideo, ReferenceToVideo, AddGuide, latent and sigma helpers; no local Regenerate node |
| [Flow-Aligned-Regenerate](https://github.com/xmarre/MiniMax-H3-Flow-Aligned-Regenerate/tree/a6249b8343becc1458a4555d2bb25cd523983c90) | Community, author xmarre; `a6249b8343becc1458a4555d2bb25cd523983c90`; code Apache-2.0 | Independent approximation; excluded as native backend |

Pinned links identify the inspected snapshots. Dynamic API schemas/pricing were retrieved on 2026-09-30; they do not expose a Git revision. Machine-readable evidence includes file sizes and available LFS SHA-256 values obtained through metadata, not weight downloads.

The current [native Comfy implementation](https://github.com/Comfy-Org/ComfyUI/blob/8cfe5e1ecb97512dea8deaac15e1228d7e6feeb1/comfy_extras/nodes_minimax_h3.py) was also checked: it adds Fun ControlNet classes, not a native Regenerate-2K class. Region-regeneration wording in a mask tooltip is not this capability. Those other modes were not changed.

Searches covered MiniMax H3 regenerate, resample, 2K, video regeneration, checkpoint, upscale, weights, ComfyUI and high-resolution video-to-video. A Hugging Face model API search for `H3 regenerate` returned no entries. Search names alone were not used as capability evidence.

## Published model structure

The [root index](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/model_index.json) declares `MiniMaxH3ModularPipeline`: Qwen3-VL encoder/processor, tokenizer, video and audio VAEs, transformer, transformer_ref and schedulers. [FL2VA index](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/FL2VA/model_index.json) declares `t2va`, `fl2va`; [Ref2VA index](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/Ref2VA/model_index.json) declares only `ref2va`. Task aliases are empty. No regeneration task/component is declared.

The two [transformer configs](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/transformer/config.json) have the same structural values: 50 layers, 24 video input channels, 32 audio input channels, patch `[1,2,2]`. `num_refiner_layers=2` is not evidence of a separate 2K refinement checkpoint. The [video VAE config](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/vae/config.json) has 24 latent channels, 16× spatial compression, temporal factors and 17-frame clips. The [audio config](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/audio_vae/config.json) specifies 32 kHz. These encode/decode components do not supply the missing regeneration semantics.

The published Base weights are BF16 under the [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE). This identifies the Base license, not a license for unpublished regeneration weights. `dac_alias_free_resample.py` is audio resampling; `assets/*2k.mp4` are demonstration videos; `full-2k-*` files are API scripts. None is a local 2K model component.

Metadata totals (decimal bytes, including configs, not measured loaded memory):

| Published Base directory | Bytes | Approx. GiB |
|---|---:|---:|
| FL2VA complete original partition | 144,051,182,625 | 134.16 |
| Ref2VA complete original partition | 144,051,182,613 | 134.16 |
| Root transformer, each variant | 66,280,569,250 | 61.73 |
| Root text encoder | 66,726,510,529 | 62.14 |
| Root video VAE | 10,415,635,127 | 9.70 |
| Root audio VAE | 605,431,611 | 0.56 |

Root diffusers and original task partitions are alternative layouts with duplicated content; do not sum them as a required download. No regeneration checkpoint filename, size, dtype, hash, license, separate head or task-specific weight is available to pin.

## Why MATLOW reports resample=false

The inspected local files were restricted to the H3 manifest/model manager, worker schemas/capabilities, MATLOW runtime, reserved Diffusers adapter, hosted regeneration service/client, and H3 UI/tests. Extra UI files were inspected only to find how regeneration labels are presented. No unrelated archive/report was read.

1. `workers/minimax-h3/model-manifest.yaml` pins Base and fused community generation components, not a native regenerate backend. The fused MATLOW transformer is `MATLOWAI/minimax-h3-fused-turbo-int8-convrot` revision `8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3`, file `diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors`, 20,980,178,976 bytes; manifest SHA-256 `4262e4e9963c553fa00016bbe83961407a4fc0a888be95fd836c8d4f2304e48b`.
2. `app/model_manager.py:DOWNLOADS` contains generation variants and modifiers; no resample download/routing specification.
3. `app/models.py:ResampleInput` reserves source video, prompt and `target_resolution=2k`; a request schema does not implement inference.
4. `matlow_int8.py:capabilities()` explicitly returns `resample.available=False`. `execute()` rejects tasks outside `t2va/fl2va/ref2va` before constructing its runtime.
5. `matlow_runtime.py` loads the pinned fused transformer and encoder, calls ImageToVideo or ReferenceToVideo conditioning, samples and decodes. It has no native base-video regeneration task. INT8 fusion is for published generation weights, not proof of a missing quantized regeneration module.
6. `main.py:/v1/capabilities` serializes backend capability views. The API failure remains `capability_not_available`; there is no silent upscale substitution.
7. `diffusers.py` is an unimplemented/unvalidated GPU integration boundary and explicitly marks open regeneration weights unavailable.

**Root cause:** no published compatible native backend/recipe plus no implemented local regeneration path. This is not established as an INT8 incompatibility or a hidden capability that only needs a flag. Shared Base architecture might eventually support a published recipe, but the inspected release does not supply one. A loader-only change is not currently justified. The capability flag remains false.

## Existing Regenerate 2K concept and community exclusion

The official API workflow is the source of the existing 2K concept. In Comfy, `MinimaxHailuo03RegenerateNode` is `is_api_node=True`, under partner/video/MiniMax, and sends to `/proxy/minimax/v2/video_regeneration` with Comfy auth and an uploaded source video. It does not name or load local regeneration weights. The [official script](https://github.com/MiniMax-AI/MiniMax-H3/blob/d21241f0a4b3acbb34c97dae47fa417b7065e438/scripts/readme/full-2k-t2va-h3-regenerate-2k.sh) likewise sends Base output to MiniMax remotely.

`packages/adapters/h3/src/index.ts:createH3RegenerationClient` uses Bearer `MINIMAX_API_KEY`, `POST /v2/video_regeneration`, model `MiniMax-H3`, prompt + `base_video`, and `resolution=2K`, then polls `/v2/query/video_generation/{id}` and downloads a result URL. `apps/server/src/h3-regeneration/service.ts` uses this hosted client. Availability means credentials configured; it does not verify access, acceptance, output or local execution. Its input gate requires a completed portable `minimax.h3.generate` tool job and a selected local MP4 under server data (default maximum 100 MiB). It forwards prompt and video, not original image/audio/video references; referenced-generation coverage is incomplete. An H3 queue evaluation job ID is not automatically such a portable tool-job ID.

The community Flow-Aligned project explicitly disclaims reproducing closed H3-Regenerate-2K. Inspection of its pinned `nodes.py` and `handoff.py` confirms MODEL + captured H3_FLOW_TRAJECTORY patching, low/high grid handoff, re-noising and optional learned 3D latent-upscaler provider. It uses ordinary Base conditioning/sampling and changes generation trajectories. Its companion latent-upscaler checkpoint is not a native regenerate checkpoint. A finished fal MP4 does not contain the original denoising trajectory. Its code license does not establish companion-weight licensing or quality. No community Python was imported/executed, no custom node installed. This could only be a separately authorized experimental route; it is excluded from this capability.

## Hosted constraints and fal lineage

The [official schema](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration) supports either an account-owned source task (whitelist, succeeded, queryable within seven days) or one `base_video` with matching original inputs. Video mode requires an audio track, 24 fps, dimensions divisible by 32, area 589,824–1,032,192 pixels, and 107–362 frames in increments of 17. Use the actual final model prompt and matching references. Output is 2K via task/result URL. Arbitrary-video processing is excluded. Audio preservation versus regeneration is unspecified; do not assume preservation.

**fal MP4: unverified.** Its URL/bytes can fit video-mode transport without a MiniMax task ID, but acceptance and exact original conditioning remain unproven. MAX-I1's 1344×768/24 fps satisfy the provided spatial/fps requirements. Exact frame count, audio and final conditioning were not probed in this research. No request was sent. [Schema](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration).

[Official pricing](https://platform.minimax.io/docs/pricing/overview): regeneration output $0.05/s; original input materials may be billed again (audio free, first five images free then $0.025/image, reference video $0.05/s). Five output seconds imply $0.25 for output only. The current adapter uses a configurable $0.05/s baseline; its quote does not include all potential input charges or establish the billable duration of this source. No payment/call occurred.

## RTX 3080 Laptop, 16 GB: feasibility without execution

| Requested native-backend datum | Research result |
|---|---|
| Disk / exact weights / hashes / license / dtype | No native backend published/found; unknown, not zero |
| Minimum / expected / peak VRAM | Unknown; no validated native loading path |
| Expected system RAM / swap | Unknown; no measurements or stress test |
| CPU and GPU utilization | Not measured; a future model/offload test could be substantial |
| CPU offload requirement | Unknown for native regeneration |
| First test and five-second runtime | Unknown; no defensible minute estimate |
| Native input/output dimensions, fps/duration limits | No local contract published; hosted constraints are not a local contract |
| Native audio behavior | Unknown |

Context only, not native regeneration estimates: published Base transformer alone is ~61.73 GiB in BF16, before activations. Pruning cached AdaLN branches and quantization reduce Base weight storage but do not add regeneration. Current fused INT8 transformer alone is ~19.54 GiB; a fully resident copy exceeds 16 GiB before other tensors. The current runtime therefore stages/offloads generation components: encoder released after conditioning, VAE cleared before diffusion/reloaded for decode, transformer released before VAE, dynamic memory mode, tiled VAE with 256/64 tile/overlap. NVFP4/AWQ encoder file is ~14.61 GiB, INT8 video VAE ~2.95 GiB, audio VAE ~0.56 GiB (manifest sizes). These are storage context, not simultaneous VRAM peaks.

Illustrative arithmetic only: doubling both video dimensions quadruples spatial latent tokens at fixed temporal length. Full dense attention's pairwise work can grow quadratically with token count; optimized attention avoids storing the entire matrix, and this does not predict actual peak VRAM. VAE chunking does not by itself bound transformer attention memory. The closed regeneration module's sparse attention, input conditioning and temporal windows are unknown. 16 GB feasibility cannot be inferred from a Base preview success. FP16/BF16/FP8/INT8 conversion or CPU offload experiments are deferred. No minimum hardware recommendation for the unpublished native backend is asserted.

## SnarkRoute changes and verification

- Added a visible, disabled **Local Regenerate 2K / Local unavailable** card with the missing-backend reason.
- Added a separate **Hosted MiniMax Regeneration** card. A lightweight internal GET to `/api/h3-regeneration/availability` reads credential configuration only. Configured credentials display **Configured · unverified**, never Verified; unknown/error/absent credentials stay distinct. There is no render or paid action on these cards.
- Clarified legacy local operation and 2K production-stage labels. No queue architecture, Import Set, Ref2VA, generic upscale or provider path was changed.
- Improved MATLOW's unavailable reason. Capability status before/after: local false → false; hosted key-dependent configuration remains separate, no new validation claimed.
- Added three UI status tests and a worker test that rejects resample before runtime construction/model loading; extended existing capability-reason assertion. Initial expected failures were checked before implementation.
- Focused UI tests: `pnpm exec vitest run src/features/h3/H3RegenerationStatus.test.ts src/features/h3/H3QueuePanel.test.ts --maxWorkers=1 --minWorkers=1` from `apps/studio`: 31 passed.
- MATLOW tests: `.venv/Scripts/python.exe -m pytest tests/test_matlow_int8_backend.py` from `workers/minimax-h3`: 16 passed, using fixtures/stubs without model loading.
- `pnpm build` from `apps/studio`: TypeScript and Vite passed; bundle-size warning remains. Focused Python syntax compilation passed. Server/adapter code was inspected but not modified; their builds were not needed.
- `git diff --check` for touched tracked code passed. JSON parsed successfully with Node. `graphify update .` completed AST-only: 9,632 nodes, 20,254 edges, 519 communities. The generated HTML uses an aggregated community view. Optional SQL parser is absent; no dependency was installed. New research prose was not submitted for LLM semantic extraction.

## Conditional future test — not runnable now

`LOCAL-M2K-01` is reserved, **not queued**. Source is existing MAX-I1, provider fal, model `fal/minimax-h3-max`, job `01a0e48c-d255-7df2-a10e-9fcbb4e5ac7d`, path `apps/server/data/h3-max-eval/2026-09-27-controlled/MAX-I1/output.mp4`. File size 4,826,842 bytes; lightweight SHA-256 checked and matches `ed5dc65e35c27707655cf025b2e9a6cf36fdabdb8ebe9708adf7875db467e8f9`. User-provided metadata: 1344×768, 24 fps, ~5.184 s; no media decoding performed.

**Exact next heavy command/job: none.** Inventing a command for an absent backend would be misleading. Next permissible step is another metadata/code review when a genuine publication exists. Before any heavy test, pin its code/weights/revision/license/size/hash, inspect code/dependencies, establish source conditioning and native settings, disclose CPU/GPU/RAM/offload/runtime estimates, prepare one concrete command for approval, and wait for separate user confirmation. No new fal generation is needed.

If eventually approved, use recommended native settings and the documented high-resolution target; do not silently substitute generic upscale. Use an isolated session, explicit unload/swap, and never keep two large transformers resident. Do not disturb the running Base worker merely to probe feasibility.

Future review plan: compare original/output face, hair, clothing, pose, composition/camera/background, motion/timing, lighting, object details, identity and small features. Check texture/face/hair/edges/fabric/background, aliasing, compression, oversharpening and invented detail. Check flicker, crawling, face/hair/object mutation, texture boiling and motion/detail stability. Metrics are supporting evidence only. Make two rows at 0/25/50/75/100% with matched frames and optional 100% crops; assess whether it preserves the clip or creates a similar new one. Inspect audio explicitly without assuming preservation.

After approval only, record load/encode/diffusion/decode and total time, peak VRAM, system RAM/swap, output bytes, input/output hashes, exact revision/settings and lineage. Validate output and model unloading, worker liveness and a separately authorized Base recovery job. Local availability requires installed/loaded model, completed real job and validated output; before that retain unavailable or a supported unverified state. No `output.mp4`, comparison sheet or heavy render asset was created in this run.

READY FOR HEAVY TEST: NO
