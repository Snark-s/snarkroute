# FLUX.3 Image Klein: native Diffusers worker

**No ComfyUI.** Local image generation/editing behind the SnarkRoute Model Gateway,
for the owner's RTX 3080 Laptop (16 GB VRAM, 32 GB RAM). Zero API cost.

## Path

```text
Codex / Claude --MCP image_generate--> SnarkRoute 4317 --Model Gateway job--> ai.image.generate
  --> provider flux3_native (apps/server/src/providers/flux3-native.ts)
  --> GPU admission (local_runtime_admission, runtime id "flux3")
  --> persistent worker 127.0.0.1:8093 (worker.py) --> PNG asset
```

- `worker.py`: stdlib HTTP, loopback only, Bearer `FLUX3_WORKER_TOKEN`.
  `/health` (identity `snarkroute-flux3-worker`), `/runtime`, `/generate`,
  `/unload`, `/shutdown`. Loads the model lazily on the first job, keeps it,
  releases VRAM after `FLUX3_IDLE_UNLOAD_SEC` (default 300) of idleness.
- `infer.py`: `validate_request`, `load_pipeline`, `render`. Also the one-shot
  CLI (`stdin` JSON) used as a fallback when no worker token is configured.
- Server side: `apps/server/src/services/flux3-native-local.ts` (start/stop/status),
  registered in `local-runtime-supervisor.ts` as `flux3` (demand heavy), port in
  `service-endpoints.json` (`flux3_native`, 8093). The worker is started on demand
  by the first job, or from Мастерская / `local_runtime_start`.
- Model: official gated `black-forest-labs/flux-3-image-klein`, transformer
  `variants/fp8r` with `BFLQuantizationConfig` + automatic CPU offload. Ampere has
  no fast FP8 kernels, weights are dequantized per step. The 9B prompt upsampler is
  not loaded (absent in `Flux3DistilledAutoBlocks`, diffusers 0.41.0.dev0).

## Enable

1. `.venv` exists (diffusers 0.41.0.dev0, torch 2.11 cu128); HF access to the gated
   repo is granted.
2. Weights download on the first real load into the default Hugging Face cache.
3. Smoke once: `powershell -File smoke-run.ps1` -> `results/smoke-512.png`,
   `results/smoke-done.txt` (exit code, seconds), `results/smoke-gpu.csv`.
4. Only after a successful smoke: `FLUX3_NATIVE_ENABLED=1` in the root `.env`,
   then «Перезапустить SnarkRoute». `FLUX3_WORKER_TOKEN` is already in `.env`.
5. End-to-end through MCP:
   `node <tsx cli> apps/server/scripts/mcp-image-smoke.ts "a red fox in a birch forest"`.

## Measured on this laptop (2026-10-21, 512x512, 16 steps)

- Denoise 18 s (~1.8 it/s); render 23 s; cold job through MCP incl. worker start
  and model load 46-52 s. Peak VRAM ~11 GB (owner baseline ~2.3 GB).
- First ever load downloads ~13+ GB of weights (took ~65 min at 4-17 MB/s).
- After VRAM unload the process still holds ~10 GB RAM, so on idle
  (`FLUX3_IDLE_UNLOAD_SEC`, default 300) the worker **exits**; the next job
  restarts it automatically.
- `smoke-run.ps1` must set `$OutputEncoding` to UTF-8: PowerShell 5 otherwise
  pipes the JSON as ASCII and the Cyrillic output path becomes `???`.

## Limits

- One job at a time (GPU lock). 512x512 / 16 steps is the measured baseline;
  larger sizes are not measured yet.
- References: up to 10 local PNG/JPEG/WEBP. Editing quality on complex pose changes
  and style holding is weaker than cloud models; the art-director loop is meant to
  catch that.
- The previous `flux3-comfy` prototype is superseded and must not be used.
