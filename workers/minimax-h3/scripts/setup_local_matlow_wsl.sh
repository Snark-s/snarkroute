#!/usr/bin/env bash
# Prepare pinned headless Comfy core dependencies. This never installs or starts its GUI/server.

set -Eeuo pipefail
umask 077

readonly H3_HOME="${H3_HOME:-${HOME}/h3}"
readonly APP_DIR="${H3_APP_DIR:-${H3_HOME}/runtime/snarkroute-h3}"
readonly CUDA_VENV="${H3_SGLANG_VENV:-${H3_HOME}/runtime/sglang-venv}"
readonly COMFYUI_DIR="${H3_MATLOW_COMFYUI_DIR:-${H3_HOME}/runtime/comfyui-core}"
readonly COMFYUI_REVISION="f938505952476e48a12687eac696cdc94d48a3fe"
readonly UV_BIN="${H3_UV_BIN:-${HOME}/.local/bin/uv}"

[[ -x "${CUDA_VENV}/bin/python" ]] || { printf 'fatal: CUDA environment missing: %s\n' "$CUDA_VENV" >&2; exit 1; }
[[ -x "$UV_BIN" ]] || { printf 'fatal: uv missing: %s\n' "$UV_BIN" >&2; exit 1; }
[[ -f "${APP_DIR}/requirements.matlow.txt" ]] || { printf 'fatal: worker files are not synced\n' >&2; exit 1; }

if [[ ! -d "${COMFYUI_DIR}/.git" ]]; then
  git init "$COMFYUI_DIR"
  git -C "$COMFYUI_DIR" remote add origin https://github.com/Comfy-Org/ComfyUI.git
fi
if [[ "$(git -C "$COMFYUI_DIR" rev-parse HEAD 2>/dev/null || true)" != "$COMFYUI_REVISION" ]]; then
  git -C "$COMFYUI_DIR" fetch --depth 1 origin "$COMFYUI_REVISION"
  git -C "$COMFYUI_DIR" checkout --detach FETCH_HEAD
fi
[[ "$(git -C "$COMFYUI_DIR" rev-parse HEAD)" == "$COMFYUI_REVISION" ]] || exit 1

"$UV_BIN" pip install --python "${CUDA_VENV}/bin/python" -r "${APP_DIR}/requirements.matlow.txt"
env H3_BACKEND=matlow_int8 H3_MATLOW_COMFYUI_DIR="$COMFYUI_DIR" PYTHONPATH="$APP_DIR" \
  "${CUDA_VENV}/bin/python" "${APP_DIR}/scripts/matlow_selftest.py"
