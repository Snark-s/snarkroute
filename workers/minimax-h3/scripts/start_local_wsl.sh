#!/usr/bin/env bash
# Start the selected local MiniMax H3 backend on a 16 GiB WSL GPU.

set -Eeuo pipefail
umask 077

readonly H3_HOME="${H3_HOME:-${HOME}/h3}"
readonly APP_DIR="${H3_APP_DIR:-${H3_HOME}/runtime/snarkroute-h3}"
readonly SGLANG_VENV="${H3_SGLANG_VENV:-${H3_HOME}/runtime/sglang-venv}"
readonly MODEL_DIR="${H3_MODEL_DIR:-${H3_HOME}/models/MiniMax-H3}"
readonly DATA_DIR="${H3_DATA_DIR:-${H3_HOME}}"
readonly VARIANT="${H3_LOCAL_VARIANT:-fl2va}"
readonly API_PORT="${H3_API_PORT:-18080}"
readonly TOKEN_FILE="${H3_WORKER_TOKEN_FILE:-${H3_HOME}/runtime/worker-token}"
readonly RUNTIME_DIR="${H3_HOME}/runtime/local"
readonly LOG_DIR="${RUNTIME_DIR}/logs"
readonly API_PID_FILE="${RUNTIME_DIR}/h3-api.pid"
readonly SGLANG_PID_FILE="${RUNTIME_DIR}/sglang.pid"
readonly API_LOG="${LOG_DIR}/h3-api.log"
readonly SGLANG_LOG="${LOG_DIR}/sglang.log"
readonly LOCAL_BACKEND="${H3_LOCAL_BACKEND:-matlow_int8}"

case "$VARIANT" in
  fl2va) readonly SGLANG_PORT="${H3_SGLANG_PORT:-30010}" ;;
  ref2va) readonly SGLANG_PORT="${H3_SGLANG_PORT:-30011}" ;;
  *) printf 'fatal: H3_LOCAL_VARIANT must be fl2va or ref2va\n' >&2; exit 2 ;;
esac

die() { printf 'fatal: %s\n' "$*" >&2; exit 1; }
stage() { printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }

pid_is_h3_process() {
  local pid="$1" role="$2" command
  [[ "$pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/${pid}/cmdline" ]] || return 1
  command="$(tr '\0' ' ' < "/proc/${pid}/cmdline")"
  case "$role" in
    h3-api) [[ "$command" == *"uvicorn app.main:app"* && "$command" == *"--app-dir ${APP_DIR}"* ]] ;;
    sglang) [[ "$command" == *"${APP_DIR}/scripts/sglang_entrypoint.py"* ]] ;;
    *) return 1 ;;
  esac
}

[[ -x "${SGLANG_VENV}/bin/python" ]] || die "CUDA Python environment is missing: ${SGLANG_VENV}"
[[ -x "${SGLANG_VENV}/bin/uvicorn" ]] || die "uvicorn is missing from CUDA Python environment"
[[ -s "$TOKEN_FILE" ]] || die "worker token is missing: ${TOKEN_FILE}"
chmod 600 "$TOKEN_FILE"

mkdir -p "$LOG_DIR" "${DATA_DIR}/outputs" "${DATA_DIR}/runtime/tmp"
for entry in "${SGLANG_PID_FILE}:sglang" "${API_PID_FILE}:h3-api"; do
  pid_file="${entry%:*}"
  role="${entry##*:}"
  if [[ -f "$pid_file" ]] && pid_is_h3_process "$(<"$pid_file")" "$role"; then
    die "H3 is already running (pid file: ${pid_file})"
  fi
  rm -f -- "$pid_file"
done

SERVICE_TOKEN="$(<"$TOKEN_FILE")"
[[ -n "$SERVICE_TOKEN" ]] || die "worker token file is empty"

stop_started() {
  local entry pid_file role pid
  for entry in "${API_PID_FILE}:h3-api" "${SGLANG_PID_FILE}:sglang"; do
    pid_file="${entry%:*}"
    role="${entry##*:}"
    [[ -f "$pid_file" ]] || continue
    pid="$(<"$pid_file")"
    if pid_is_h3_process "$pid" "$role"; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap 'stage "startup failed; stopping processes from this launch"; stop_started' ERR INT TERM

if [[ "$LOCAL_BACKEND" == "matlow_int8" ]]; then
  readonly COMFYUI_DIR="${H3_MATLOW_COMFYUI_DIR:-${H3_HOME}/runtime/comfyui-core}"
  readonly MATLOW_ROOT="${H3_MATLOW_MODEL_ROOT:-${H3_HOME}/models}"
  readonly MATLOW_TRANSFORMER="${H3_MATLOW_TRANSFORMER_FILE:-${MATLOW_ROOT}/MATLOWAI/minimax-h3-fused-turbo-int8-convrot/diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors}"
  readonly MATLOW_ENCODER="${H3_MATLOW_TEXT_ENCODER_FILE:-${MATLOW_ROOT}/Comfy-Org/MiniMax-H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors}"
  readonly MATLOW_VIDEO_VAE="${H3_MATLOW_VIDEO_VAE_FILE:-${MATLOW_ROOT}/Kijai/MiniMax-H3-experimental/minimax_h3_video_vae_int8_convrot.safetensors}"
  readonly MATLOW_AUDIO_VAE="${H3_MATLOW_AUDIO_VAE_FILE:-${MATLOW_ROOT}/Comfy-Org/MiniMax-H3/vae/minimax_h3_audio_vae_fp32.safetensors}"
  [[ -d "$COMFYUI_DIR/.git" ]] || die "pinned ComfyUI core is missing: ${COMFYUI_DIR}"
  [[ -f "$MATLOW_TRANSFORMER" ]] || die "MATLOWAI transformer is missing or still downloading"
  [[ -f "$MATLOW_ENCODER" ]] || die "MATLOWAI text encoder is missing or still downloading"
  [[ -f "$MATLOW_VIDEO_VAE" ]] || die "MATLOWAI video VAE is missing or still downloading"
  [[ -f "$MATLOW_AUDIO_VAE" ]] || die "MATLOWAI audio VAE is missing or still downloading"

  stage "running mandatory comfy-kitchen INT8 ConvRot CUDA self-test"
  nohup env \
    H3_BACKEND=matlow_int8 \
    H3_MATLOW_PROFILE=local_fast \
    H3_MATLOW_COMFYUI_DIR="$COMFYUI_DIR" \
    H3_MATLOW_MODEL_ROOT="$MATLOW_ROOT" \
    H3_MATLOW_NATIVE_AUDIO="${H3_MATLOW_NATIVE_AUDIO:-1}" \
    PYTHONPATH="$APP_DIR" \
    "${SGLANG_VENV}/bin/python" "${APP_DIR}/scripts/matlow_selftest.py"

  stage "starting authenticated MATLOWAI H3 worker on localhost:${API_PORT}"
  env \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
    CUDA_MODULE_LOADING=LAZY \
    H3_WORKER_SERVICE_TOKEN="$SERVICE_TOKEN" \
    H3_BACKEND=matlow_int8 \
    H3_ENABLED_VARIANTS=fl2va,ref2va \
    H3_ACCEPT_MODEL_LICENSE="${H3_ACCEPT_MODEL_LICENSE:-1}" \
    H3_MATLOW_PROFILE=local_fast \
    H3_MATLOW_COMFYUI_DIR="$COMFYUI_DIR" \
    H3_MATLOW_MODEL_ROOT="$MATLOW_ROOT" \
    H3_MATLOW_NATIVE_AUDIO="${H3_MATLOW_NATIVE_AUDIO:-1}" \
    H3_MATLOW_MAX_SWAP_GIB="${H3_MATLOW_MAX_SWAP_GIB:-12}" \
    H3_RESULT_DIR="${DATA_DIR}/outputs" \
    H3_TEMP_DIR="${DATA_DIR}/runtime/tmp" \
    H3_MODEL_DIR="${H3_HOME}/models" \
    H3_JOB_TIMEOUT_SECONDS=7200 \
    "${SGLANG_VENV}/bin/uvicorn" app.main:app --app-dir "$APP_DIR" --host 127.0.0.1 --port "$API_PORT" --no-access-log \
    >"$API_LOG" 2>&1 </dev/null &
  printf '%s\n' "$!" >"$API_PID_FILE"

  deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    kill -0 "$(<"$API_PID_FILE")" 2>/dev/null || die "H3 API exited; inspect ${API_LOG}"
    if curl -fsS -H "Authorization: Bearer ${SERVICE_TOKEN}" "http://127.0.0.1:${API_PORT}/ready" >/dev/null 2>&1; then
      trap - ERR INT TERM
      unset SERVICE_TOKEN
      stage "H3 matlow_int8 is ready: http://127.0.0.1:${API_PORT}"
      if [[ "${H3_LOCAL_FOREGROUND:-0}" == "1" ]]; then
        wait "$(<"$API_PID_FILE")"
      fi
      exit 0
    fi
    sleep 5
  done
  die "MATLOWAI H3 did not become ready; inspect ${API_LOG}"
fi

[[ "$LOCAL_BACKEND" == "sglang" ]] || die "H3_LOCAL_BACKEND must be matlow_int8 or sglang"
[[ -x "${SGLANG_VENV}/bin/sglang" ]] || die "SGLang environment is missing: ${SGLANG_VENV}"
[[ -x "${APP_DIR}/.venv/bin/uvicorn" ]] || die "H3 API environment is missing: ${APP_DIR}/.venv"
[[ -f "${MODEL_DIR}/model_index.json" ]] || die "MiniMax H3 root index is missing: ${MODEL_DIR}/model_index.json"
[[ -d "${MODEL_DIR}/${VARIANT^^}" ]] || die "MiniMax H3 ${VARIANT^^} weights are incomplete or missing"
[[ -f "${MODEL_DIR}/${VARIANT^^}/transformer/model-00013-of-00013.safetensors" ]] || die "MiniMax H3 ${VARIANT^^} transformer download is incomplete"
[[ -f "${MODEL_DIR}/${VARIANT^^}/text_encoder/model-00014-of-00014.safetensors" ]] || die "MiniMax H3 ${VARIANT^^} text encoder download is incomplete"
[[ -f "${MODEL_DIR}/${VARIANT^^}/video_vae/source/model.safetensors" ]] || die "MiniMax H3 ${VARIANT^^} video VAE download is incomplete"
[[ -f "${MODEL_DIR}/${VARIANT^^}/audio_vae/model.safetensors" ]] || die "MiniMax H3 ${VARIANT^^} audio VAE download is incomplete"

stage "starting SGLang 0.5.19 ${VARIANT} with the lossless 16 GiB/32 GB Recipe A"
nohup env \
  CUDA_HOME="${SGLANG_VENV}/lib/python3.12/site-packages/nvidia/cu13" \
  PATH="${SGLANG_VENV}/lib/python3.12/site-packages/nvidia/cu13/bin:${PATH}" \
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  HF_HOME="${H3_HOME}/cache" \
  H3_SGLANG_PRECISION_PROFILE=bf16_offload \
  "${SGLANG_VENV}/bin/python" "${APP_DIR}/scripts/sglang_entrypoint.py" \
  --model-path "$MODEL_DIR" \
  --model-variant "$VARIANT" \
  --num-gpus 1 \
  --tp-size 1 \
  --ulysses-degree 1 \
  --attention-backend fa \
  --performance-mode memory \
  --layerwise-offload-components dit,text_encoder,vae \
  --layerwise-resident-layers video_vae=36 \
  --enable-torch-compile false \
  --host 127.0.0.1 \
  --port "$SGLANG_PORT" \
  >"$SGLANG_LOG" 2>&1 </dev/null &
printf '%s\n' "$!" >"$SGLANG_PID_FILE"

stage "starting the authenticated SnarkRoute H3 worker on localhost:${API_PORT}"
nohup env \
  H3_WORKER_SERVICE_TOKEN="$SERVICE_TOKEN" \
  H3_BACKEND=sglang \
  H3_ENABLED_VARIANTS="$VARIANT" \
  H3_SGLANG_PRECISION_PROFILE=bf16_offload \
  SGLANG_FL2VA_URL="http://127.0.0.1:${SGLANG_PORT}" \
  SGLANG_REF2VA_URL="http://127.0.0.1:${SGLANG_PORT}" \
  H3_RESULT_DIR="${DATA_DIR}/outputs" \
  H3_TEMP_DIR="${DATA_DIR}/runtime/tmp" \
  H3_MODEL_DIR="${H3_HOME}/models" \
  H3_JOB_TIMEOUT_SECONDS=14400 \
  "${APP_DIR}/.venv/bin/uvicorn" app.main:app --app-dir "$APP_DIR" --host 127.0.0.1 --port "$API_PORT" --no-access-log \
  >"$API_LOG" 2>&1 </dev/null &
printf '%s\n' "$!" >"$API_PID_FILE"

stage "waiting for model load; this can take a long time on the first local launch"
deadline=$((SECONDS + 7200))
while (( SECONDS < deadline )); do
  kill -0 "$(<"$SGLANG_PID_FILE")" 2>/dev/null || die "SGLang exited; inspect ${SGLANG_LOG}"
  kill -0 "$(<"$API_PID_FILE")" 2>/dev/null || die "H3 API exited; inspect ${API_LOG}"
  if curl -fsS -H "Authorization: Bearer ${SERVICE_TOKEN}" "http://127.0.0.1:${API_PORT}/ready" >/dev/null 2>&1; then
    trap - ERR INT TERM
    unset SERVICE_TOKEN
    stage "H3 ${VARIANT} is ready: http://127.0.0.1:${API_PORT}"
    exit 0
  fi
  sleep 10
done

die "H3 did not become ready within two hours; inspect ${SGLANG_LOG} and ${API_LOG}"
