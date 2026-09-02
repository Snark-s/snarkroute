# Vast.ai: first MiniMax H3 deployment

No instance, volume, token, or paid resource is created by this runbook automatically.

## Select an offer

Use Vast.ai's live search at rental time. Record the complete hourly price in `GPU_USD_PER_HOUR` and set `MAX_BUDGET_USD`. First rent 1×RTX 4090 24 GB, at least 192 GiB RAM (256 GiB preferred), 250 GB disk, and an NVIDIA r580-or-newer driver capable of CUDA 13 containers. Run explicit `kitchen_int8`; use BF16 offload as the A/B baseline. The lossless alternative is 2×RTX 5090 32 GB with peer access and 384 GiB-class RAM. Avoid interruptible offers for the first model download unless the volume persists independently.

Set maximum duration/auto-destroy before launch. Bind the worker to localhost and use an SSH tunnel or private authenticated proxy.

Start with a read-only offer search and inspect the returned host RAM, disk bandwidth, reliability, and total hourly price before renting:

```bash
vastai search offers \
  'gpu_name=RTX_4090 num_gpus=1 gpu_ram>=24 cpu_ram>=192 disk_space>=250 verified=true rentable=true driver_version>=580 direct_port_count>=1' \
  -o 'dph_total'
```

Prefer 256 GiB host RAM when available. Do not relax the RAM floor merely because the GPU matches.

## Prepare and launch

After SSH, transfer the repository and inject tokens with Vast secrets or a mode-600 environment file outside Git:

```bash
cd workers/minimax-h3
export H3_WORKER_SERVICE_TOKEN="$(openssl rand -hex 32)"
export HF_TOKEN="<Vast secret>"
export GPU_USD_PER_HOUR="<current offer total>"
export MAX_BUDGET_USD="<hard test budget>"
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --dry-run
uv run python scripts/download_models.py --component h3-base-fl2va --model-dir /models --accept-license
uv run python scripts/verify_models.py --component h3-base-fl2va --model-dir /models --checksums
docker build -t snarkroute-h3-worker:0.2.0 .
docker build -f Dockerfile.sglang -t snarkroute-h3-sglang:3f26feb .
```

Use the single-card `kitchen_int8` `docker run` commands in the RunPod runbook; they are provider-neutral and fail closed if the CUDA kernel self-test fails. For 2×5090 BF16 use:

```bash
H3_MODEL_DIR=/models H3_BACKEND=sglang H3_ENABLED_VARIANTS=fl2va \
  docker compose -f compose.example.yml --profile gpu up -d
```

The compose recipe keeps SGLang internal. Tunnel only port 8080:

```bash
ssh -L 8080:127.0.0.1:8080 <vast-user>@<vast-host>
```

## Health, benchmark and guards

```bash
curl -fsS http://127.0.0.1:8080/health
curl -fsS -H "Authorization: Bearer $H3_WORKER_SERVICE_TOKEN" http://127.0.0.1:8080/ready
python scripts/smoke_test.py --url http://127.0.0.1:8080 --require-gpu
python scripts/benchmark.py --case-id first-int8 --system h3 --profile kitchen_int8 \
  --verified-on-gpu --gpu-model "RTX 4090" --gpu-usd-per-hour "$GPU_USD_PER_HOUR" \
  --render-seconds 0 --attempts 1 --accepted-results 0
python scripts/watchdog.py --gpu-usd-per-hour "$GPU_USD_PER_HOUR" \
  --max-budget-usd "$MAX_BUDGET_USD" --idle-minutes 20 --execute
```

The local watchdog stops the compose stack. Vast's maximum-duration/auto-destroy remains mandatory because stopped containers do not stop instance billing. Save benchmark JSON/CSV to persistent storage.

## Stop and remove

```bash
docker compose -f compose.example.yml --profile gpu-int8 down
docker ps --format '{{.Names}}'
nvidia-smi
```

In Vast.ai: stop/destroy the exact instance; confirm it disappeared from active rentals; list attached volumes; preserve wanted results; delete only the verified test volume; check no reserved/running offers remain and review the final charge. Closing SSH or stopping Docker is not cleanup.

If the lossless 2×5090 profile was used instead, substitute `--profile gpu` in the cleanup command.
