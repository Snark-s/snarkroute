# SnarkRoute local upscale worker

Standalone, authenticated image upscale/restoration worker for the existing SnarkRoute Model Gateway. It does not use ComfyUI and does not download weights on import or startup.

## Install and run

```powershell
cd workers/local-upscale
uv sync --extra gpu --extra test
$env:LOCAL_UPSCALE_WORKER_TOKEN = '<random-long-token>'
$env:LOCAL_UPSCALE_RUNTIME = 'auto'
uv run uvicorn app.main:app --host 127.0.0.1 --port 8091
```

Configure the SnarkRoute server with the same token:

```dotenv
LOCAL_UPSCALE_WORKER_URL=http://127.0.0.1:8091
LOCAL_UPSCALE_WORKER_TOKEN=replace-me
```

For contract-only development and CI, use `LOCAL_UPSCALE_RUNTIME=mock`; mock output is nearest-neighbor scaling and must not be presented as AI inference.

## Add or download a model

Models are declared in `model-registry.json`. Add a complete entry with an explicit license, source page, HTTPS download URL, exact byte size, SHA-256, architecture/runtime, scale, content tags, and tile/alpha metadata. Unknown-license entries are rejected. Adding a registry entry does not download anything.

```powershell
uv run python scripts/download_models.py --model 4x-realesrgan-x4plus --dry-run
uv run python scripts/download_models.py --model 4x-realesrgan-x4plus
uv run python scripts/verify_models.py --model 4x-realesrgan-x4plus
```

Weights live under `LOCAL_UPSCALE_MODEL_DIR` (`./models` by default). The CLI reuses the shared local-worker download layer also used by H3 for disk gating; its pinned-file transport is resumable through a `.part` file and publishes the result only after size and SHA-256 verification.

## Model Gateway request

First import a PNG/JPEG with `POST /api/assets/import`, then submit its returned `id` and `path` through the existing endpoint:

```json
{
  "capability": "image.upscale",
  "nodeType": "local_upscale",
  "outputMediaType": "image",
  "modelId": "local_upscale/4x-realesrgan-x4plus",
  "providerModelId": "4x-realesrgan-x4plus",
  "provider": "local_upscale",
  "parameters": { "scale": 4, "tile_size": 256, "tile_overlap": 32, "device": "cuda" },
  "inputs": [{ "kind": "image", "role": "source", "index": 0, "assetId": "asset_...", "path": "C:\\...\\input.png" }],
  "hostType": "boojumroute"
}
```

Submit this JSON to `POST /api/model-gateway/jobs`, poll `GET /api/model-gateway/jobs/:id`, cancel with `POST /api/model-gateway/jobs/:id/cancel`, and download the PNG from the returned `resultUrl`. BoojumRoute, After Effects, Snark Director and API callers share this transport and discover models through capabilities/catalog.

## MVP limits

- Single PNG/JPEG images only; no video/FFmpeg pipeline.
- Registry includes four verified BSD-3-Clause Real-ESRGAN-family checkpoints, not the whole OpenModelDB catalog.
- Published checkpoints are `.pth`, so the first registry entries use the safe PyTorch/Spandrel boundary. ONNX Runtime CUDA is implemented for future `.onnx` entries; TensorRT has an explicit runtime extension hook but no implementation.
- Models expose only their native scale. Output is always lossless PNG. RGB is inferred; alpha is resized independently and restored. ICC bytes are retained without an implicit color conversion.
- OOM is reported as `gpu_oom`; tile size is never silently retried.
