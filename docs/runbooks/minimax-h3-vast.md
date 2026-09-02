# Vast.ai: first MiniMax H3 deployment

No instance, volume, token, or paid resource is created by this runbook automatically.

## H3 Studio batch sessions

H3 Studio keeps its queue and imported source files locally under SnarkRoute's `data/h3-studio` and `data/assets` directories. Adding or rearranging tasks does not contact Vast and does not rent a GPU. A batch session processes ready tasks strictly one at a time and downloads each MP4 result before moving to the next task.

The managed button **Rent → render → destroy** is enabled only after the local server has all of the following saved settings:

- `VAST_API_KEY`;
- `HF_TOKEN`;
- `H3_WORKER_SERVICE_TOKEN`;
- `H3_VAST_TEMPLATE_HASH` for a Vast template that starts this repository's H3 worker without manual SSH steps;
- `H3_VAST_WORKER_URL_TEMPLATE`, an external HTTPS URL such as `https://{public_ipaddr}:8000`;
- `H3_VAST_MAX_HOURLY_USD`, the hard offer-price ceiling.

The Vast template is part of the deployment contract: it must expose the authenticated H3 API, download or mount the pinned weights, run readiness checks, and keep the service alive. A generic CUDA/Jupyter template is not sufficient.

A generic NVIDIA PyTorch/Jupyter template can still be used for a **manual first test** with
`scripts/bootstrap_vast_fl2va.sh`. That script does not make the template compatible with the
managed button; it prepares one SSH-tunnelled FL2VA worker on an already rented instance.

Immediately after Vast returns an instance ID, SnarkRoute persists that exact ID in `data/h3-studio/queue.json`. The session destroys that ID in a `finally` cleanup path after success, render failure, or startup timeout, then confirms the instance is absent. If confirmation fails, H3 Studio enters a red `cleanup_failed` state, retains the exact instance ID, and exposes a retry button. Do not assume billing stopped until cleanup is confirmed. Vast documents that destroying an instance stops all charges, while stopping it may continue storage charges: [Destroy instance](https://docs.vast.ai/api-reference/instances/destroy-instance).

## Select an offer

Use Vast.ai's live search at rental time. Record the complete hourly price in `GPU_USD_PER_HOUR` and set `MAX_BUDGET_USD`. First rent a verified 48 GB modified RTX 4090 (or another 48 GB CUDA-13-capable GPU), at least 256 GiB usable RAM, 300 GB disk, and an NVIDIA r580-or-newer driver. Run explicit `kitchen_int8`; use BF16 offload as the A/B baseline. The 2026-08-30 validation peaked at 30,422 MiB during startup, 18,788 MB during a 20-step 1344×768 generation, and 247.46 GiB cgroup memory, so an ordinary 24 GB 4090/192 GiB host is now a follow-up compatibility test rather than the safest first rental. The lossless alternative is 2×RTX 5090 32 GB with peer access and 384 GiB-class RAM. Avoid interruptible offers for the first model download unless the volume persists independently.

Set maximum duration/auto-destroy before launch. Bind the worker to localhost and use an SSH tunnel or private authenticated proxy.

Start with a read-only offer search and inspect the returned host RAM, disk bandwidth, reliability, and total hourly price before renting:

```bash
vastai search offers \
  'gpu_name=RTX_4090 num_gpus=1 gpu_ram>=24 cpu_ram>=192 disk_space>=250 verified=true rentable=true driver_version>=580 direct_port_count>=1' \
  -o 'dph_total'
```

Prefer 256 GiB host RAM when available. Do not relax the RAM floor merely because the GPU matches.

## Prepare and launch

### Fast manual bootstrap on a generic NVIDIA PyTorch image

Copy `workers/minimax-h3` to `/workspace/snarkroute-h3` and `workers/shared` to
`/workspace/shared`. Copy the Hugging Face token to `/workspace/snarkroute-h3/.hf_token` and
create `/workspace/snarkroute-h3/.runtime.env`, both mode 600. Do not paste either token into
shell history or logs:

```bash
chmod 600 /workspace/snarkroute-h3/.hf_token /workspace/snarkroute-h3/.runtime.env
cd /workspace/snarkroute-h3
nohup bash scripts/bootstrap_vast_fl2va.sh > /workspace/bootstrap.log 2>&1 &
tail -f /workspace/bootstrap.log
```

The runtime file contains only these assignments:

```bash
H3_ACCEPT_MODEL_LICENSE=1
H3_WORKER_SERVICE_TOKEN='<random 64-hex-character value>'
```

The bootstrap pins SGLang commit `3f26febaff04bac4cfefd60bdc9097bc26a96cb8`, installs
`comfy-kitchen==0.2.31` with its pinned wheel hash, downloads only the pinned FL2VA partition,
verifies all LFS hashes, runs the real CUDA kernel self-test, and starts both services on
localhost. It exits instead of selecting BF16 when `kitchen_int8` fails. Readiness is written to
`/workspace/h3-ready.json`; detailed logs are `/workspace/sglang-h3.log` and
`/workspace/h3-api.log`.

Open the local tunnel only after the log reports readiness:

```bash
ssh -N -L 18080:127.0.0.1:18080 <vast-user>@<vast-host> -p <vast-port>
```

Use `http://127.0.0.1:18080` as the H3 Studio worker address. This path is for one manually
supervised run: after the MP4 is downloaded, destroy the exact Vast instance and confirm that it
and any unwanted volume are absent.

### Container build

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
