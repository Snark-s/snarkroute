# Local upscale provider

`local_upscale` is the image-only local provider behind the existing SnarkRoute Model Gateway. BoojumRoute, After Effects, Snark Director and API clients use the same async path:

```text
client -> /api/model-gateway/jobs -> route executor -> @snarkroute/local-upscale -> local worker -> PNG result asset
```

The provider does not use ComfyUI. Its API cost is `0`; the normal gateway cost object is retained with zero provider/base cost.

## Setup

See [`workers/local-upscale/README.md`](../workers/local-upscale/README.md) for installation, explicit model download/verification, environment variables and the complete request example. In short:

```powershell
cd workers/local-upscale
uv sync --extra gpu --extra test
$env:LOCAL_UPSCALE_WORKER_TOKEN = '<random-long-token>'
uv run python scripts/download_models.py --model 4x-realesrgan-x4plus
uv run uvicorn app.main:app --host 127.0.0.1 --port 8091
```

Set `LOCAL_UPSCALE_WORKER_URL` and the same `LOCAL_UPSCALE_WORKER_TOKEN` for `apps/server`. Model weights stay in `LOCAL_UPSCALE_MODEL_DIR`; startup never downloads them.

## Registry and runtimes

`workers/local-upscale/model-registry.json` is the source of model metadata. Entries require a known license, source URL, exact download URL, byte size and SHA-256. The initial entries use PyTorch/Spandrel because the verified OpenModelDB resources are `.pth`. The worker also has an ONNX Runtime CUDA implementation for future `.onnx` entries and a registration boundary for TensorRT; TensorRT is not part of the MVP.

Capabilities are fetched live from the worker and merged into Model Catalog V1. Missing weights appear as unavailable in `/api/models/v1` and are excluded from executable model choices. No model list is hardcoded in BoojumRoute or the AE panel.

## Image behavior

Inputs are PNG/JPEG. RGB inference uses configurable overlapping tiles and weighted stitching, including partial edge tiles. RGBA alpha is resized separately and restored. ICC bytes are retained without an implicit color conversion. Output is always lossless PNG. CUDA OOM, missing weights, invalid inputs, timeout and cancellation are structured worker errors.

## MVP boundaries

- No video/frame extraction/FFmpeg pipeline.
- No automatic OpenModelDB-wide import or download.
- No TensorRT implementation or hidden OOM retries.
- No face restoration, temporal processing or arbitrary output scale.
- No provider-specific transport in BoojumRoute, AE or Snark Director.
