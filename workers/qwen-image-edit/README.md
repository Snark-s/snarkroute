# Qwen-Image-Edit-2511 on stable-diffusion.cpp

**No ComfyUI, no Python.** Precise local image editing ("change X, keep everything
else", text on images, character consistency) behind the SnarkRoute Model Gateway.
Complements FLUX.3 Klein (`workers/flux3-native`), which is better at generating new
images and style. Zero API cost.

## Path

```text
Codex / Claude --MCP image_generate(provider=qwen_edit_local, references=[src])-->
  SnarkRoute 4317 --Model Gateway--> provider qwen_edit_local (providers/qwen-edit-local.ts)
  --> GPU admission (runtime id "qwen_edit")
  --> sd-server 127.0.0.1:8094, native async API /sdcpp/v1/img_gen + /sdcpp/v1/jobs/{id}
  --> PNG asset
```

- Engine: official leejet/stable-diffusion.cpp Windows CUDA 12 build, tag
  `master-982-0518b34`, in `bin/` (`sd-server.exe`, `sd-cli.exe`).
- Weights in `models/` (`model-registry.json` holds URL, size and SHA-256):
  `qwen-image-edit-2511-Q4_K_M.gguf` (13.2 GB, unsloth), `Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf`
  (4.7 GB) + `Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf` (0.85 GB, the vision part: without it
  the model cannot see the image it edits), `qwen_image_vae.safetensors` (0.25 GB).
- Launch flags (`qwenEditServerArgs` in `services/qwen-edit-local.ts`): `--offload-to-cpu`,
  `--flash-attn off,diffusion=on` (the docs' `--diffusion-fa` is deprecated), `--cfg-scale 2.5`,
  `--sampling-method euler`, `--flow-shift 3`, and **`--model-args qwen_image_zero_cond_t=true`**:
  the sd.cpp docs say 2511 quality degrades significantly without it.
- sd-server has **no auth** and **no idle unload**. It binds to 127.0.0.1 only; SnarkRoute stops
  the process after `QWEN_EDIT_IDLE_SEC` (default 300) without jobs, so RAM is returned.

## Install / enable

1. `powershell -File download.ps1` (resumable, SHA-256 verified, unzips `bin/`).
   Result: `results/download-done.txt`, log `results/download.log`.
2. Smoke: `powershell -File smoke-run.ps1` edits FLUX.3's fox; measures time, VRAM, RAM.
3. After a good smoke: `QWEN_EDIT_ENABLED=1` in the root `.env`, «Перезапустить SnarkRoute».

## Measured on this laptop (2026-10-21, 512x512, 20 steps)

- Edit ~94 s (3.5 s/it), cold MCP job incl. sd-server start and preload 98 s.
- Peak VRAM ~15.3 GB of 16 (baseline 2.2 GB): very little headroom; peak RAM ~13.7 GB.
- Download: ~19.5 GB; use `fetch-then-verify.ps1` (hf_xet, 12-16 MB/s) rather than plain
  `download.ps1` (single-stream curl, ~1.5 MB/s); download.ps1 still verifies SHA-256.
- First test: "make the tail blue" turned most of the body blue; the art-director retry
  "recolor ONLY the tail, the body stays orange" was exact. Name what must NOT change.

## Limits

- FLUX.3 and Qwen-Edit are both heavy and do not share the 16 GB GPU at once; the admission
  check reports the conflict instead of starting both.
- RAM: measured peak ~13.7 GB (not the ~18-19 GB the file sizes suggest). With heavy apps open,
  switch `QWEN_EDIT_DIFFUSION_FILE` to `...-Q3_K_M.gguf` (9.9 GB). VRAM is the tighter limit.
- Up to 3 reference images (the first is the one edited).
- License: the model card states Apache 2.0 for "Qwen-Image"; re-check for commercial use
  of Edit-2511 outputs specifically.
