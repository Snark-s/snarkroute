# Veda sparse attention in SnarkRoute H3

Source: https://github.com/veda-sparse/Veda-on-ComfyUI
Vendored snapshot: `fd59c7277ccc37ebf1a8f6823474b8c2ef2e33a0` (Veda 0.2.0).
License: MIT; see `LICENSE` and `NOTICE.md` for SageAttention / Miowtion attributions.

This directory retains the upstream PyTorch engine, Triton sparse backend,
predictor selection, H3 layout adapter, and the ModelPatcher callback adapter.
**The ComfyUI node, UI, workflow executor, and HTTP server are NOT installed.**
SnarkRoute's existing headless MATLOW H3 transformer loader already relies on
a pinned Comfy core library to support `comfy_quant`. Veda adds no user-facing
ComfyUI dependency, although the adapter uses the existing headless
ModelPatcher lifecycle.

Configuration is on the local H3 worker:

- `H3_MATLOW_ATTENTION=dense`: unmodified attention.
- `H3_MATLOW_ATTENTION=auto`: try Veda on supported NVIDIA GPUs, fall back.
- `H3_MATLOW_ATTENTION=veda`: require functional sparse attention.
- `H3_MATLOW_VEDA_PREDICTOR_FILE`: predictor checkpoint path.
- `H3_MATLOW_VEDA_GENERATED_SPARSITY` and `H3_MATLOW_VEDA_REFERENCE_SPARSITY`: default `90%`.
- `H3_MATLOW_VEDA_VERBOSE=1`: extra diagnostics.

The startup probe checks the predictor and compiles/tests the Triton kernel.
A successful probe does **not** prove attention is faster in a real render.
The job result's `metadata.attention.diagnostics` records actual sparse calls,
fallbacks, and approximate computed attention fraction when the sampling
cleanup callback finishes. `attention_backend` distinguishes active sparse
calls from merely installing the patch.

On the RTX 3080 Laptop SM86, predictor loading and the Triton INT8 backend
self-test have passed. A matched A/B benchmark and visual quality comparison
are still needed to claim a speedup. The 600Step-Preview filename currently
reports `step=100` in its internal metadata; use the bundle's metadata as
the checkpoint's source of truth.
