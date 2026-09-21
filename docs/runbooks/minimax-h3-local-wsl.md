# MiniMax H3 on the local Lenovo/WSL workstation

This installation is intentionally separate from Docker Desktop and any running ComfyUI application. Ubuntu 24.04 lives in `Y:\WSL\H3-Ubuntu`; the model, runtime, inputs, and outputs stay inside that WSL filesystem so offload can use Linux memory mapping efficiently. The `matlow_int8` backend imports a pinned subset of ComfyUI core as a Python library because the checkpoint uses its native `comfy_quant` layout. It never starts the ComfyUI GUI, HTTP server, or workflow editor.

## Installed layout

- Model: `/home/serge/h3/models/MiniMax-H3`
- SGLang environment: `/home/serge/h3/runtime/sglang-venv`
- Pinned headless Comfy core source: `/home/serge/h3/runtime/comfyui-core`
- SnarkRoute H3 worker: `/home/serge/h3/runtime/snarkroute-h3`
- Inputs: `/home/serge/h3/inputs`
- Results: `/home/serge/h3/outputs`
- Logs and PID files: `/home/serge/h3/runtime/local`
- Worker token: `/home/serge/h3/runtime/worker-token` (mode `600`)

Pinned runtime: SGLang `0.5.19`, PyTorch `2.13.0+cu130`, Diffusers `0.37.0`, `comfy-kitchen==0.2.31`, `comfy-aimdo==0.4.15`, `av==17.0.0`, `torchsde==0.2.6`, ComfyUI core `f938505952476e48a12687eac696cdc94d48a3fe`, original MiniMax H3 revision `42ed227ee7df40d41602854ae760620d6eb651fe`, and MATLOWAI fused checkpoint revision `8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3`. The complete additive dependency pins are in `requirements.matlow.txt`.

The WSL limit in `C:\Users\serge\.wslconfig` is 28 GB RAM plus 16 GB swap. Closing WSL with `wsl --shutdown` returns that memory to Windows.

## Download or resume the pinned model

The local downloader first completes FL2VA, then downloads only the Ref2VA-specific transformer and index. Five component trees that are byte-identical at the pinned revision are hard-linked, saving about 77.8 GB without changing the paths expected by SGLang. Interrupted downloads are retried and resumed. Both resulting variants are checked against the pinned Hugging Face LFS hashes before the command reports success.

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'H3_ACCEPT_MODEL_LICENSE=1 ~/h3/runtime/snarkroute-h3/scripts/download_local_wsl.sh'
```

The command requires the existing Hugging Face login and does not print or copy the token.

## Local INT8 checkpoint

The local-first model set is 40,444,247,247 bytes (37.67 GiB): a 20.98 GB fused Turbo INT8 transformer, 15.69 GB NVFP4/AWQ text encoder, 3.17 GB INT8 ConvRot video VAE, and 0.61 GB FP32 audio VAE. They are separate single-file Comfy-format artifacts and cannot reuse the original SGLang/Diffusers shards byte-for-byte.

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'H3_ACCEPT_MODEL_LICENSE=1 ~/h3/runtime/snarkroute-h3/scripts/download_matlow_wsl.sh'
wsl.exe -d Ubuntu-24.04 -- bash -lc '~/h3/runtime/snarkroute-h3/scripts/setup_local_matlow_wsl.sh'
```

## Start and stop from H3 Studio

The default launcher selects `matlow_int8`, the local profile intended for this 16 GB laptop. T2VA, 10-second FL2VA, first/last-frame generation and visual Ref2VA have passed local GPU tests. Ref2VA remains experimental. Audio references and `final` are rejected. `local_fast` is pinned to 960x544 (or the corresponding aspect-ratio canvas), 4 denoise steps, dense attention, DynamicVRAM and native generated H3 audio.

### Visual references and motion

- **Персонаж и стиль**: attach an image and refer to it as `<Picture 1>` in the prompt. An image is a semantic reference, not a fixed first frame.
- **Перенос движения**: attach a video and describe which movement/camera behavior to take from `<Video 1>`. An optional image supplies the character or appearance via `<Picture 1>`.
- **Перенос стиля видео**: attach both sources; for example, `Keep the motion and camera from <Video 1>, with the visual style from <Picture 1>`.
- Local video references use at most the first 15 seconds (or start at the API's `start_time_seconds`), resampled to 24 fps, with the longest side at most 512 px and dimensions divisible by 32. Their existing soundtracks are ignored as references; the output receives newly generated native H3 audio. Reference tags are numbered separately by media type.
- This is generative reference conditioning, not deterministic pose tracking or frame-exact motion copying. Use Preview; native sound, Final, object replacement and automatic tracking are separate features.

`scripts/matlow_reference_smoke.py --image /path/reference.png --video /path/reference.mp4` submits a five-second local GPU test through the authenticated worker API. It reads the existing local token without printing it. Inspect the returned job with `--status JOB_ID`.

On 2026-09-13 the combined image+video smoke job `417209be-de35-4062-8c77-5be9272cfa16` succeeded on the RTX 3080 Laptop with native audio enabled: 285.6 seconds compute, valid 960x544 MP4, 124 frames at 24 fps, plus a non-silent 32 kHz stereo AAC track (5.167 seconds, mean -17.7 dB). Peak process RAM was 24.85 GiB and swap grew by 0.16 GiB. This validates the execution and audio path, not precise motion or identity fidelity across arbitrary references.

The normal web flow needs no terminal, worker URL or token:

1. Start SnarkRoute and open **H3 Studio**.
2. Press **«Запустить локальный H3»**. The server reads the protected token inside WSL, launches the worker on `127.0.0.1:18080`, runs the mandatory CUDA-kernel self-test and saves the connection itself.
3. Wait for the **«H3 готов»** badge. Build or edit the local queue; for the verified path select **Preview**.
4. Press **«Рендер на подключённом H3»**. Jobs are submitted sequentially through the existing authenticated worker API.
5. When the queue finishes, press **«Остановить локальный H3»**. Models and results remain on disk; only the worker processes stop. Local execution has no rental billing.

The commands below are the recovery/manual path only.

Start the local INT8 worker:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc '~/h3/runtime/snarkroute-h3/scripts/start_local_wsl.sh'
```

Start the original SGLang/BF16 path explicitly (still retained, one task family at a time):

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'H3_LOCAL_BACKEND=sglang H3_LOCAL_VARIANT=fl2va ~/h3/runtime/snarkroute-h3/scripts/start_local_wsl.sh'
```

Stop H3 without deleting weights or results:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc '~/h3/runtime/snarkroute-h3/scripts/stop_local_wsl.sh'
```

If one-click setup is unavailable, use `http://127.0.0.1:18080` as the H3 worker address. Copy the service token to the Windows clipboard without printing it:

```powershell
wsl.exe -d Ubuntu-24.04 -- bash -lc 'cat ~/h3/runtime/worker-token' | Set-Clipboard
```

The MATLOW launcher refuses to become ready unless the exact Comfy core and `comfy-kitchen` versions match and a real INT8 ConvRot CUDA operation succeeds. It never falls back to BF16 or CPU. Each successful generation records process and system RAM peaks, absolute swap usage, swap growth, PyTorch allocator peak, per-stage timings, and the selected kernel. Under `comfy-aimdo==0.4.15`, NVML or `nvidia-smi` polling during generation can destabilize the native memory hooks; it is therefore deliberately disabled. `peak_vram_gib` is an allocator peak, not total device occupancy. Swap growth above 12 GiB interrupts the run with an explicit `resource_exhausted` job error.

## Verified local acceptance runs

Both runs used the real RTX 3080 Laptop GPU (16 GiB), PyTorch `2.13.0+cu130`, CUDA 13.0, `comfy-kitchen==0.2.31`, `comfy-aimdo==0.4.15`, DynamicVRAM, 960x544, 124 frames, four denoise steps and 256/64 VAE tiles:

| Mode | Seed | Total | Text | Diffusion | VAE | Peak process RAM | Swap growth |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| T2VA | 42 | 153.33 s | 21.90 s | 102.17 s | 22.08 s | 24.35 GiB | 0 GiB |
| First-frame FL2VA | 31415 | 179.08 s | 40.19 s | 111.97 s | 20.67 s | 24.81 GiB | 0 GiB |

The T2VA allocator peak was 2.37 GiB and the first-frame run reported 2.48 GiB. These are not claims about full-device VRAM because Aimdo owns allocations outside PyTorch's ordinary reserved counter. A 32 GB host is sufficient for the two verified preview modes when other heavy applications are closed; 64 GB remains the safer recommendation for longer queues, future modes and multitasking. The previous normal-memory run reached 26.62 GiB process RAM and grew swap by 9.50 GiB, so DynamicVRAM remains the default.

## Switching task families

`matlow_int8` audio references and final-quality mode remain unavailable until real GPU tests and implementation support. Run the stop command before switching to SGLang or another backend. No capability is marked verified merely because its loader or kernel self-test succeeds.
