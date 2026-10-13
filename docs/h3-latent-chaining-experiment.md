# MiniMax H3 latent chaining experiment

Status 2026-10-13: **phase 1 implemented: opt-in capture only**. No latent
context injection, stitching, one-pass decode, or tone stabilization yet.
The standard worker output and API remain unchanged.

## Why

The current MATLOW headless runtime produces `sampled` as an H3 paired
NestedTensor (video [B,24,T,H/16,W/16], audio [B,32,2,T40]) before decoding.
The current first/last-frame continuation requires VAE re-encoding. That
roundtrip may affect quality, but eliminating it alone cannot prevent
generation-induced drift. H3 has distinct temporal video and audio grids.

The archive preserves *both* sampled streams without lossy re-encoding.
It does not make future video sampling automatically accept their contents.

## Capture on the local MATLOW worker

Set the absolute path in the **worker** environment before starting it:

```bash
export H3_LATENT_CAPTURE_DIR=/home/serge/h3/latent-experiments
```

No value: capture is disabled. Restart the worker after changing its
environment. On every successful sampler run, it tries to save
`h3-<uuid>.safetensors` atomically with a manifest (seed, model variant,
number of requested frames, dimensions, VAE mode, stream shapes). The sampled
video+audio data are exact; the normal MP4 decoding remains unchanged.
Failures in optional capture are logged but do not abort the MP4.

These archives contain original generated media data. Treat as private and
manage retention yourself. Use a persistent directory outside worker temp.
Each archive is bounded to a 1 GiB raw tensor limit. No cloud upload.

Code: `app/backends/h3_latent_archive.py`; hook in `matlow_runtime.py`.
Read back with `read_h3_latent(path)` (video, audio, manifest CPU tensors).
Python static checks passed; hardware-generation test has not run.
The local WSL worker test environment used on 2026-10-13 lacked the `torch`
package, so the pytest test was skipped there, not reported as passed.

## Three controlled comparisons (future implementation)

A. Baseline: standard last-frame image Extend with normal per-clip VAE.
B. Direct: saved AV latent -> next segment's temporal conditioning without
   pixel decode/encode. Use a causal, time-aligned video/audio tail.
C. B plus carefully measured latent tone normalization **of the conditioning
   tail** (not blind global normalization).

Keep scene/prompt, resolution, fps, seed strategy, sampler, VAE and steps the
same; do three continuations after the initial clip. Save all latents and
decoded clips for inspection. Do not use an image-only or audio-only context.

Read primary mechanics from upstream H3 and community experiments:
- https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py
- https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context
- https://github.com/pmhaidn/ComfyUI-Minimax-H3-Extender

Upstream custom nodes are references only, not copied into this project.
They may depend on ComfyUI runtime patches, pinned versions and other licenses.
SnarkRoute remains headless and must fail closed on unsupported H3 layouts.

## Explicit technical gates before enabling latent Extend

1. Confirm saved video/audio tensors and decode/redecode equality on an
   actual H3 local run; verify exact dtype and tensor shape.
2. Build a sampler-conditioning adapter capable of temporal interior anchors
   plus audio on its own timeline. The current MATLOW I2V condition only
   supports first/last image keyframes. Reusing the saved tensors as-is
   as sampler input is not equivalent to motion context.
3. Define compatible overlap trimming and time-grid rules. The H3 temporal
   layout is not arbitrary framewise concatenation (17k+5 pixel frame runs).
   Audio follows a separate 40 Hz latent grid.
4. Implement a separate **offline** latent-assembly/decode prototype.
   A long single VAE pass might exceed a 16 GiB GPU even after DiT offload;
   tiled/chunked decode with explicit temporal boundary handling is likely
   needed. Compare its seam behavior against per-clip decode.
5. Judge with objective measurements: median linear luminance, 5th/95th
   percentile luma, local contrast, saturation, motion continuity and
   audio cross-correlation at seams. Include subjective artifact review.
6. Only if results improve should this become a supported experimental
   route option; the public worker API/ORP cannot change silently.

**No guarantee:** one final VAE decode fixes codec roundtrips, not an
intrinsic drift introduced at each diffusion run.
