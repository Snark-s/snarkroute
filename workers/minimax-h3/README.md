# SnarkRoute MiniMax H3 worker

Versioned, authenticated, backend-neutral worker for MiniMax H3. It has no ComfyUI runtime, custom nodes, or ComfyUI container. The CUDA/SGLang image alone pins the independent `comfy-kitchen==0.2.31` kernel extension for the optional `kitchen_int8` capability; the API image does not install it.

The stable facade owns validation, asynchronous jobs, idempotency, cancellation, metadata and result storage. `mock` validates the API only; `sglang` delegates to the official `/v1/videos` contract; `diffusers` is an isolated future boundary and currently reports unavailable.

## Local no-GPU verification

```bash
uv sync --extra test --python 3.12
uv run ruff format --check app scripts tests
uv run ruff check app scripts tests
uv run pytest
```

Start the mock worker (use a real random token outside tests):

```bash
export H3_WORKER_SERVICE_TOKEN="$(openssl rand -hex 32)"
export H3_BACKEND=mock
uv run uvicorn app.main:app --host 127.0.0.1 --port 8080
python scripts/smoke_test.py --url http://127.0.0.1:8080
```

Or build/run the API image without weights:

```bash
docker build -t snarkroute-h3-worker:0.2.0 .
docker run --rm -p 127.0.0.1:8080:8080 \
  -e H3_WORKER_SERVICE_TOKEN="$H3_WORKER_SERVICE_TOKEN" \
  -e H3_BACKEND=mock snarkroute-h3-worker:0.2.0
```

`GET /health` is unauthenticated and proves only process liveness. `/ready` and every `/v1/*` endpoint require the bearer token. A mock result begins with `SNARKROUTE-H3-MOCK` and is never a real MP4 inference result.

## Models

Dry-run first; this does not need a token or download weights:

```bash
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --dry-run
```

After reviewing the pinned MiniMax community license, pass acceptance explicitly and provide `HF_TOKEN` through the environment/secret manager:

```bash
export HF_TOKEN="..."
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --accept-license
uv run python scripts/verify_models.py --component h3-base-fl2va --model-dir /models --checksums
```

The FL2VA partition is about 144.05 GB (134.16 GiB). Keep at least 250 GB for one partition, caches, image layers, temporary output, and a rollback margin. Both original partitions together are about 288.10 GB; the repository also contains a separate ~210.37 GB Diffusers-format root, so never download the entire repository accidentally.

The safest first repeat GPU test is 1×modified RTX 4090 48 GB, at least 256 GiB usable RAM, and 300 GB disk with compose profile `gpu-int8`. On 2026-08-30 this shape completed a 20-step 1344×768 T2VA functional benchmark with synchronized H.264/AAC output in 259.71 seconds; generation reported 18,788 MB peak VRAM, while startup briefly used about 30,422 MiB and cgroup memory peaked at 247.46 GiB. Startup runs a real CUDA kernel self-test and never silently falls back to BF16 or Diffusers. A normal 24 GB RTX 4090 is officially documented upstream but remains unverified by this project. Use `gpu`/`gpu-bf16` for the official 2×RTX 5090 lossless profile.

For a supervised first run on a generic Vast NVIDIA PyTorch/Jupyter image, copy this directory to
`/workspace/snarkroute-h3`, copy `workers/shared` to `/workspace/shared`, supply the two mode-600
secret files described in the Vast runbook, and run `scripts/bootstrap_vast_fl2va.sh`. It prepares
only FL2VA, binds both services to localhost, and fails closed if `kitchen_int8` is unavailable.

See [the main H3 document](../../docs/minimax-h3.md), the [RunPod runbook](../../docs/runbooks/minimax-h3-runpod.md), and the [Vast.ai runbook](../../docs/runbooks/minimax-h3-vast.md).
