# FLUX.3 Image Klein: native Diffusers backend

**No ComfyUI.** Experimental local backend for RTX 3080 16 GB,
currently implemented but **not yet installed nor GPU-tested**.

## Design

- SnarkRoute image generation routes use `flux3_native:flux-3-image-klein`.
- The dedicated node is `flux3.native.generate`.
- `apps/server/src/providers/flux3-native.ts` launches the fixed script
  `workers/flux3-native/infer.py` with one JSON request over stdin.
- Native Python worker loads the official, gated
  `black-forest-labs/flux-3-image-klein` through Hugging Face Diffusers.
- Uses the official `variants/fp8r/model.safetensors` transformer with
  `BFLQuantizationConfig`, plus `ComponentsManager.enable_auto_cpu_offload`.
  This avoids an FP8-fast-kernel requirement, **but** on Ampere (RTX 3080)
  the weights are dequantized each step. Speed and fit are not established.
- No persistent Python process, local HTTP endpoint, ComfyUI or third-party
  generation API. Output is a local PNG with zero inference API fees.
- Each call loads the model from local cache (slow first prototype).
  Later replace this with an owned worker for persistent caching and
  Local Process Manager scheduling after validating actual GPU inference.

## Resources

Owner's computer: 16 GB RTX 3080 VRAM, 32 GB physical RAM, around 12.5 GB
free RAM at the time of development. Loading Qwen3-VL and the transformer
can still exhaust VRAM or RAM even with CPU offload. Start at 512x512 with
no references, 16 steps, a short prompt, and consider reducing other memory
loads. No claim of fully working generation until actual smoke test.

## Setup (not yet executed)

1. Make sure access to the **original** gated model
   `https://huggingface.co/black-forest-labs/flux-3-image-klein`
   is granted to your local Hugging Face login. Accepting the separate
   ComfyUI repackaged checkpoint gate does not prove access here.
2. With explicit owner permission run
   `workers/flux3-native/setup-native.ps1 -Install` to create an isolated
   Python virtual environment and install CUDA-enabled PyTorch and Diffusers.
3. Verify a local Hugging Face token exists *without exposing it to the chat*.
   The script downloads model weights on first actual inference via Diffusers.
   Expect many GB of download and significant RAM / disk usage.
4. Run a single local 512x512 generation directly, inspect PNG, peak memory,
   duration, and failures. Improve memory optimization before enabling automatic
   routing in SnarkRoute.
5. Only after the worker is usable, set `FLUX3_NATIVE_ENABLED=1` in the
   **SnarkRoute server environment** and restart it. Leave unset otherwise.
6. Run targeted tests and `@snarkroute/server` build; test generation with
   the normal image generator and confirm no cloud calls.

Official sources:
- https://huggingface.co/blog/flux-3
- https://huggingface.co/docs/diffusers/modular_diffusers/modular_pipeline
- https://github.com/black-forest-labs/flux-3-image-klein

## Important

The previous `flux3-comfy` prototype is superseded and must not be
activated or used. Its owner-managed command recipes should not be used to
download weights into any ComfyUI folder. Native installation needs its own
explicitly approved workflow or a local owner operation, not an attempt to
bypass SnarkBridge restrictions.
