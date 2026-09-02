#!/usr/bin/env bash
# Bootstrap a generic NVIDIA PyTorch Vast instance for one fail-closed FL2VA session.

set -Eeuo pipefail
umask 077

readonly APP_DIR="${H3_APP_DIR:-/workspace/snarkroute-h3}"
readonly SGLANG_VENV="${H3_SGLANG_VENV:-/workspace/sglang-venv}"
readonly MODEL_DIR="${H3_MODEL_DIR:-/models}"
readonly DATA_DIR="${H3_DATA_DIR:-/data}"
readonly API_PORT="${H3_API_PORT:-18080}"
readonly SYSTEM_PYTHON="${H3_SYSTEM_PYTHON:-/usr/bin/python3}"
readonly HF_TOKEN_FILE="${H3_HF_TOKEN_FILE:-${APP_DIR}/.hf_token}"
readonly RUNTIME_ENV_FILE="${H3_RUNTIME_ENV_FILE:-${APP_DIR}/.runtime.env}"
readonly SGLANG_COMMIT="3f26febaff04bac4cfefd60bdc9097bc26a96cb8"
readonly SGLANG_SOURCE_DIR="/workspace/sglang-${SGLANG_COMMIT}"
readonly SGLANG_SOURCE_ARCHIVE="/workspace/sglang-${SGLANG_COMMIT}.tar.gz"
readonly UV_VERSION="0.12.5"

readonly BOOTSTRAP_LOG="/workspace/bootstrap.log"
readonly SGLANG_LOG="/workspace/sglang-h3.log"
readonly API_LOG="/workspace/h3-api.log"
readonly SGLANG_PID_FILE="/workspace/sglang-h3.pid"
readonly API_PID_FILE="/workspace/h3-api.pid"
readonly VERIFY_MARKER="${MODEL_DIR}/MiniMax-H3/.snarkroute-fl2va-verified-42ed227ee7df40d41602854ae760620d6eb651fe"

stage() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  printf 'fatal: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [[ -s "$1" ]] || die "required secret file is missing or empty: $1"
  chmod 600 "$1"
}

stop_started_processes() {
  local pid_file pid
  for pid_file in "$API_PID_FILE" "$SGLANG_PID_FILE"; do
    if [[ -f "$pid_file" ]]; then
      pid="$(<"$pid_file")"
      if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
    fi
  done
}

on_exit() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    stage "bootstrap failed (exit ${exit_code}); stopping processes started by this script"
    stop_started_processes
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

[[ -d "$APP_DIR" ]] || die "worker source directory not found: $APP_DIR"
[[ -x "$SYSTEM_PYTHON" ]] || die "system Python not found: $SYSTEM_PYTHON"
"$SYSTEM_PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 12), sys.version'
"$SYSTEM_PYTHON" -c 'import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))'
require_file "$HF_TOKEN_FILE"
require_file "$RUNTIME_ENV_FILE"

# This file is created locally and copied with mode 600. It must contain only shell assignments.
# shellcheck disable=SC1090
source "$RUNTIME_ENV_FILE"
[[ "${H3_ACCEPT_MODEL_LICENSE:-}" == "1" ]] || die "set H3_ACCEPT_MODEL_LICENSE=1 after reviewing the pinned MiniMax H3 license"
[[ -n "${H3_WORKER_SERVICE_TOKEN:-}" ]] || die "H3_WORKER_SERVICE_TOKEN is missing from $RUNTIME_ENV_FILE"
export H3_WORKER_SERVICE_TOKEN H3_ACCEPT_MODEL_LICENSE
export HF_TOKEN="$(<"$HF_TOKEN_FILE")"
[[ -n "$HF_TOKEN" ]] || die "HF token is empty"

mkdir -p "$MODEL_DIR" "$DATA_DIR/results" "$DATA_DIR/tmp" /workspace/.cache
export HF_HOME="${MODEL_DIR}/.hf-cache"
export UV_CACHE_DIR="/workspace/.cache/uv"
export PIP_DISABLE_PIP_VERSION_CHECK=1

stage "installing small host prerequisites"
if ! command -v git >/dev/null || ! command -v ffmpeg >/dev/null || ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git
  rm -rf /var/lib/apt/lists/*
fi

if ! command -v uv >/dev/null; then
  stage "installing uv ${UV_VERSION}"
  env -u PIP_CONSTRAINT "$SYSTEM_PYTHON" -m pip install --no-cache-dir "uv==${UV_VERSION}"
fi
readonly UV_BIN="$(command -v uv)"

stage "installing pinned H3 API worker dependencies"
cd "$APP_DIR"
env -u PIP_CONSTRAINT "$UV_BIN" sync --frozen --python "$SYSTEM_PYTHON" --no-dev

stage "installing pinned SGLang ${SGLANG_COMMIT} into an isolated CUDA environment"
if [[ ! -x "$SGLANG_VENV/bin/python" ]]; then
  "$UV_BIN" venv --python "$SYSTEM_PYTHON" --system-site-packages "$SGLANG_VENV"
fi
if [[ ! -f "$SGLANG_SOURCE_DIR/python/pyproject.toml" ]]; then
  stage "downloading the immutable SGLang commit archive"
  rm -rf "$SGLANG_SOURCE_DIR"
  mkdir -p "$SGLANG_SOURCE_DIR"
  curl -fL --retry 3 --retry-all-errors \
    "https://codeload.github.com/sgl-project/sglang/tar.gz/${SGLANG_COMMIT}" \
    -o "$SGLANG_SOURCE_ARCHIVE"
  tar -xzf "$SGLANG_SOURCE_ARCHIVE" --strip-components=1 -C "$SGLANG_SOURCE_DIR"
fi
env -u PIP_CONSTRAINT SGLANG_BUILD_RUST_EXTS=none "$UV_BIN" pip install \
  --python "$SGLANG_VENV/bin/python" --no-cache \
  "${SGLANG_SOURCE_DIR}/python[diffusion]"
env -u PIP_CONSTRAINT "$UV_BIN" pip install \
  --python "$SGLANG_VENV/bin/python" --no-cache --no-deps --only-binary=:all: \
  --require-hashes -r "$APP_DIR/requirements.sglang.txt"

stage "checking free disk before the pinned FL2VA download"
"$APP_DIR/.venv/bin/python" scripts/download_models.py \
  --component h3-base-fl2va --model-dir "$MODEL_DIR" --dry-run

stage "downloading/resuming the pinned FL2VA partition"
"$APP_DIR/.venv/bin/python" scripts/download_models.py \
  --component h3-base-fl2va --model-dir "$MODEL_DIR" --accept-license

if [[ -f "$VERIFY_MARKER" ]]; then
  stage "using the completed pinned FL2VA checksum verification marker"
else
  stage "verifying every FL2VA LFS object against the pinned Hugging Face revision"
  "$APP_DIR/.venv/bin/python" scripts/verify_models.py \
    --component h3-base-fl2va --model-dir "$MODEL_DIR" --checksums
  printf '%s\n' 'revision=42ed227ee7df40d41602854ae760620d6eb651fe bytes=144051185561' \
    >"$VERIFY_MARKER"
fi

stage "running the mandatory comfy-kitchen CUDA kernel self-test"
"$SGLANG_VENV/bin/python" "$APP_DIR/scripts/kitchen_selftest.py"

if [[ -f "$SGLANG_PID_FILE" ]] && kill -0 "$(<"$SGLANG_PID_FILE")" 2>/dev/null; then
  die "an SGLang process recorded in $SGLANG_PID_FILE is already running"
fi
if [[ -f "$API_PID_FILE" ]] && kill -0 "$(<"$API_PID_FILE")" 2>/dev/null; then
  die "an H3 API process recorded in $API_PID_FILE is already running"
fi

stage "starting FL2VA SGLang with explicit kitchen_int8; BF16 fallback is forbidden"
env \
  H3_SGLANG_PRECISION_PROFILE=kitchen_int8 \
  HF_HOME="$HF_HOME" \
  "$SGLANG_VENV/bin/python" "$APP_DIR/scripts/sglang_entrypoint.py" \
  --model-path "$MODEL_DIR/MiniMax-H3" \
  --model-variant fl2va \
  --num-gpus 1 \
  --tp-size 1 \
  --ulysses-degree 1 \
  --performance-mode memory \
  --layerwise-offload-components dit,text_encoder \
  --dit-offload-prefetch-size 1 \
  --dit-layerwise-resident-layers 0 \
  --enable-torch-compile false \
  --attention-backend fa \
  --host 127.0.0.1 \
  --port 30010 \
  >"$SGLANG_LOG" 2>&1 &
SGLANG_PID=$!
printf '%s\n' "$SGLANG_PID" >"$SGLANG_PID_FILE"

stage "starting authenticated H3 API on localhost only"
env \
  H3_WORKER_SERVICE_TOKEN="$H3_WORKER_SERVICE_TOKEN" \
  H3_BACKEND=sglang \
  H3_ENABLED_VARIANTS=fl2va \
  H3_SGLANG_PRECISION_PROFILE=kitchen_int8 \
  SGLANG_FL2VA_URL=http://127.0.0.1:30010 \
  H3_RESULT_DIR="$DATA_DIR/results" \
  H3_TEMP_DIR="$DATA_DIR/tmp" \
  H3_MODEL_DIR="$MODEL_DIR" \
  H3_JOB_TIMEOUT_SECONDS=7200 \
  "$APP_DIR/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$API_PORT" \
  >"$API_LOG" 2>&1 &
API_PID=$!
printf '%s\n' "$API_PID" >"$API_PID_FILE"

stage "waiting up to 45 minutes for model loading and authenticated readiness"
deadline=$((SECONDS + 2700))
while (( SECONDS < deadline )); do
  kill -0 "$SGLANG_PID" 2>/dev/null || die "SGLang exited during startup; inspect $SGLANG_LOG"
  kill -0 "$API_PID" 2>/dev/null || die "H3 API exited during startup; inspect $API_LOG"
  if curl -fsS \
    -H "Authorization: Bearer ${H3_WORKER_SERVICE_TOKEN}" \
    "http://127.0.0.1:${API_PORT}/ready" \
    >/workspace/h3-ready.json 2>/dev/null; then
    stage "H3 FL2VA worker is ready on 127.0.0.1:${API_PORT}"
    trap - EXIT INT TERM
    unset HF_TOKEN H3_WORKER_SERVICE_TOKEN
    exit 0
  fi
  sleep 10
done

die "H3 did not become ready within 45 minutes; inspect $SGLANG_LOG and $API_LOG"
