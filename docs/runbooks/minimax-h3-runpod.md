# RunPod: first MiniMax H3 deployment

No pod, volume, token, or paid resource is created by this runbook automatically.

## Before renting

Check live GPU/storage prices in the RunPod console. Set `GPU_USD_PER_HOUR` and `MAX_BUDGET_USD` from that quote. First choose 1×RTX 4090 24 GB, 192 GiB RAM minimum (256 GiB preferred), and a 250 GB persistent volume. Use the explicit `kitchen_int8` profile; reserve BF16 offload for the A/B baseline. The lossless alternative is 2×RTX 5090 32 GB with a 384 GiB-class host. Require an NVIDIA r580-or-newer driver capable of running the CUDA 13 image.

Set provider stop/termination time before boot. Persistent volumes may bill after a pod stops, so budget storage separately.

The public RunPod GPU catalog currently shows only about 41 GB host RAM for its generic RTX 4090 listing, far below this offload profile's project-estimated floor. Do not rent that default shape. Continue on RunPod only if the concrete Pod/host configuration exposes at least 192 GiB RAM and 250 GB persistent storage; otherwise use a verified Vast offer where `cpu_ram` and `disk_space` can be filtered explicitly.

## Build and run

Attach `/models` and a separate result volume at `/data/results` (or configure S3). Transfer the repository, inject secrets through RunPod, then:

```bash
cd workers/minimax-h3
export H3_WORKER_SERVICE_TOKEN="$(openssl rand -hex 32)"
export HF_TOKEN="<RunPod secret>"
export GPU_USD_PER_HOUR="<current console quote>"
export MAX_BUDGET_USD="<hard test budget>"
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --dry-run
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --accept-license
uv run python scripts/verify_models.py --component h3-base-fl2va --model-dir /models --checksums
docker build -t snarkroute-h3-worker:0.2.0 .
docker build -f Dockerfile.sglang -t snarkroute-h3-sglang:3f26feb .
docker network create h3-internal
docker volume create h3-results
```

Single-card `kitchen_int8` backend. `comfy-kitchen==0.2.31` is present only in this CUDA image; it is not ComfyUI and includes no custom nodes. The entrypoint runs the CUDA kernel self-test and stops on failure instead of falling back to BF16:

```bash
docker run -d --name h3-fl2va --restart unless-stopped --gpus all \
  --network h3-internal --shm-size 64g \
  -e HF_TOKEN -e H3_SGLANG_PRECISION_PROFILE=kitchen_int8 \
  -v /models:/models -v h3-results:/data/results:ro \
  snarkroute-h3-sglang:3f26feb \
  --model-path /models/MiniMax-H3 --model-variant fl2va \
  --num-gpus 1 --tp-size 1 --ulysses-degree 1 --performance-mode memory \
  --layerwise-offload-components dit,text_encoder --dit-offload-prefetch-size 1 \
  --dit-layerwise-resident-layers 0 --enable-torch-compile false \
  --attention-backend fa --host 0.0.0.0 --port 30010

docker run -d --name h3-worker --restart unless-stopped --network h3-internal \
  -p 127.0.0.1:8080:8080 -e H3_WORKER_SERVICE_TOKEN \
  -e H3_BACKEND=sglang -e H3_ENABLED_VARIANTS=fl2va \
  -e H3_SGLANG_PRECISION_PROFILE=kitchen_int8 \
  -e SGLANG_FL2VA_URL=http://h3-fl2va:30010 \
  -v h3-results:/data/results snarkroute-h3-worker:0.2.0
```

Expose only port 8080 through a private endpoint/VPN or authenticated TLS proxy. Never expose 30010/30011.

## Verify, budget and idle stop

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS -H "Authorization: Bearer $H3_WORKER_SERVICE_TOKEN" http://127.0.0.1:8080/ready
python scripts/smoke_test.py --url http://127.0.0.1:8080 --require-gpu
python scripts/benchmark.py --case-id first-int8 --system h3 --profile kitchen_int8 \
  --verified-on-gpu --gpu-model "RTX 4090" --gpu-usd-per-hour "$GPU_USD_PER_HOUR" \
  --render-seconds 0 --attempts 1 --accepted-results 0
python scripts/watchdog.py --gpu-usd-per-hour "$GPU_USD_PER_HOUR" \
  --max-budget-usd "$MAX_BUDGET_USD" --idle-minutes 20 --execute \
  --on-trigger-command "docker stop h3-worker h3-fl2va"
```

Run the watchdog as a separate systemd unit. Its local stop is defense in depth; the provider auto-stop/termination rule is authoritative. Save benchmarks outside the ephemeral container.

For the BF16 A/B run, recreate only the SGLang container with `H3_SGLANG_PRECISION_PROFILE=bf16_offload`, keep the same offload/attention flags, and record `--profile bf16_offload`. Never mark a record `--verified-on-gpu` unless that exact run completed on the GPU.

## Cleanup checklist

```bash
docker rm -f h3-worker h3-fl2va
docker network rm h3-internal
```

Then in RunPod: stop and terminate the exact pod; confirm zero running GPUs; list volumes; download wanted results; delete the named test volume only if no longer needed; re-check billing/resources. Do not delete a shared volume until its exact ID and contents are verified.
