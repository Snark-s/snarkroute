# H3 Loop GPU integration test (24 October 2026)

## Outcome
**Integration/API tests passed; the real GPU loop did not finish.**
The first run was cancelled by an explicit worker API request after approximately 13 minutes while stalled at the initial denoising model step. No MP4 was generated. Do not mark `seamless_loop` as a verified model capability.

## Environment and preconditions
- RTX 3080 Laptop GPU, 16 GiB; roughly 13.8 GiB free before the run.
- 32 GiB Windows host memory; WSL Ubuntu 24.04 limited to 28 GiB RAM / 16 GiB swap.
- SnarkRoute `matlow_int8` with pinned headless ComfyUI core `f938505952476e48a12687eac696cdc94d48a3fe`.
- The already installed Linux H3 worker was older than the Windows source. Five source files were synced without downloading/replacing model weights.
- **Pre-copy WSL backup:** `/home/serge/h3/runtime/local/backup_loop_20261024_175441`.

## Test request and evidence
- Job `b62ce7b4-a1fa-49c9-aeda-7f442239219d`.
- T2VA, `h3_base`, `duration_seconds=4.25`, 4 steps, 960×544 local_fast, `seamless_loop=true`, `loop_views=2`, `loop_pad_clips=1`, seed `1852037`.
- Worker returned `ready=true`, then `models_loaded` progress 0.20 and `conditioning_ready` progress 0.35.
- Worker log showed sampling at `0% (0/4), Model Initializing ...`, still 0/4 close to cancellation.
- Windows host memory pressure rose to 94–95% (about 1.5–1.9 GiB available).
- Explicit cancellation returned `cancelled`; job result `cancelled` with no output and no error. Raw job summary at `/home/serge/h3/outputs/h3-loop-smoke-20261024.json`.
- The local H3 worker was stopped through SnarkRoute API; subsequent Windows memory availability improved to about 10.7 GiB.
- The SnarkRoute server was restarted successfully and confirmed healthy; the worker remained off.

## Verified checks
- Python syntax for new/modified worker files: passed.
- Python loop frame/audio CPU tests: 9 passed.
- H3 adapter Vitest loop tests: 3 passed; TypeScript typecheck passed.
- H3 server TypeScript typecheck passed.
- H3 Studio TypeScript typecheck and production Vite build passed.
- Server queue/session Vitest tests: 23 passed.
- Live queue API roundtrip: `seamlessLoop=true` persisted; temporary job removed immediately after verification.
- Nothing has established an invisible image loop or clean loop audio. Video/audio seam analysis not run because there is no video.

## Next investigation (before another GPU-intensive run)
1. Profile `Model Initializing` in the pinned headless ComfyUI runtime with `h3_cyclic` patch applied. Do not assume VRAM/RAM needs match the upstream RTX 4090 configuration.
2. Test just wrapper invocation/model initialization with tiny synthetic latents or CPU mocks when possible, avoiding full generation.
3. Compare `loop_views=1` against `loop_views=2`, but recognize that this halves inference passes, **not** the length of circularly padded latents.
4. Retain base H3 normal mode unmodified and `seamless_loop` opt-in until a valid MP4 and measured seam are obtained.

## Paths
- Main implementation: `workers/minimax-h3/app/backends/h3_cyclic.py`.
- WSL sync scripts: `scripts/sync-h3-loop-wsl.ps1`, `scripts/sync-h3-loop-wsl.sh`.
- GPU test client: `workers/minimax-h3/scripts/h3_loop_gpu_smoke.py`.
- Seam assessment utility (untested due absent video): `workers/minimax-h3/scripts/h3_loop_seam_check.py`.
- Upstream: https://github.com/pxl-pshr/ComfyUI-MiniMaxH3-Loop (GPL-3.0).

Do not erase other pre-existing changes in SnarkRoute's working tree. This experimental addition is not release-verified.

## Follow-up investigation (24 October 2026, evening)
- Synthetic CPU test using the actual Linux Torch 2.13 and pinned ComfyUI:
  circular video/audio predictions preserved tensor dimensions for 1, 6 and 7 clips, with single/two-view inputs.
- Root cause localized to model and text-encoder memory pressure before the first diffusion step, not the second audio view alone. Windows RAM repeatedly reached 95% during loop requests.
- Fixed `loop_frame_count` to choose the nearest valid H3 17k+5 grid instead of skipping intermediate clip lengths.
- Loop-only preview geometry is reduced by 5/6 to 32-pixel-aligned dimensions (16:9 => 800x448); regular H3 retains 960x544.
- Confirmed ComfyUI's pinned `MiniMaxH3ImageToVideo.execute` uses the video VAE only if keyframes are present: tested with `vae=None` using a dummy text-conditioning object, passed.
- Optimized **text-only Loop** by deferring the 3.17 GiB video VAE and audio VAE until decoding, avoiding their residency alongside the 32B text encoder. Keyframe and Ref2VA paths unchanged.
- 9 Python and 3 adapter tests passed for duration/grid behavior and request serialization.
- Compact **10Eros Max Turbo** `w4a8_14gb` is installed and was tested with `loop_views=1`, 800x448:
  - Before VAE deferral: job `a9034725-65a6-4c94-a766-b0eee6e57ab4`, free Windows RAM declined from ~7 GiB to 3.5 GiB while still on `models_loaded`; cancelled deliberately.
  - After VAE deferral: job `d1ccf575-7216-427e-99dc-c66cfa073068`, initial free Windows RAM ~8.4 GiB, falling to 2.6 GiB after ~160s while still `models_loaded`; cancelled deliberately.
  - Compact weights improve memory use versus the original 20 GiB MATLOW transformer, but do not reliably fit this Windows workload with 32 GiB host RAM.
- **No successful GPU loop**; no video/audio seam comparison was possible. Never market or mark this mode GPU-verified.
- WSL source backup before final sync: `/home/serge/h3/runtime/local/backup_loop_20261024_185048`.
- Each job was explicitly cancelled and H3 stopped using its own APIs; SnarkRoute remains healthy.
- Next meaningful path: reduce co-resident Windows applications, increase host RAM to 64 GiB, or redesign text-encoder offload/quantization before another full loop GPU test. Do not automatically submit further tests under current RAM pressure.

