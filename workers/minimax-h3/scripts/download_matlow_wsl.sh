#!/usr/bin/env bash
# Download and verify the exact local_fast model set without duplicate checkpoints.

set -Eeuo pipefail
umask 077

readonly H3_HOME="${H3_HOME:-${HOME}/h3}"
readonly ROOT="${H3_MATLOW_MODEL_ROOT:-${H3_HOME}/models}"
readonly HF_BIN="${H3_HF_BIN:-${HOME}/.local/bin/hf}"
readonly REQUIRED_BYTES=40444247247
readonly MATLOW_REVISION="8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3"
readonly COMFY_REVISION="a98869194787969724c7425d95d0ed73ce9202af"
readonly KIJAI_REVISION="f4cac997f880e93cf6940af61ee8d58ef31ff7f3"

[[ "${H3_ACCEPT_MODEL_LICENSE:-}" == "1" ]] || {
  printf 'fatal: review the MiniMax H3 community license, then set H3_ACCEPT_MODEL_LICENSE=1\n' >&2
  exit 2
}
[[ -x "$HF_BIN" ]] || { printf 'fatal: hf CLI missing: %s\n' "$HF_BIN" >&2; exit 1; }
available="$(df -PB1 "$ROOT" | awk 'NR==2 {print $4}')"
(( available >= REQUIRED_BYTES + 10 * 1024 * 1024 * 1024 )) || {
  printf 'fatal: need at least 50.5 GB free for weights plus margin\n' >&2
  exit 1
}

"$HF_BIN" download MATLOWAI/minimax-h3-fused-turbo-int8-convrot \
  diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors \
  --revision "$MATLOW_REVISION" --local-dir "$ROOT/MATLOWAI/minimax-h3-fused-turbo-int8-convrot"
"$HF_BIN" download Comfy-Org/MiniMax-H3 \
  text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors \
  vae/minimax_h3_audio_vae_fp32.safetensors \
  --revision "$COMFY_REVISION" --local-dir "$ROOT/Comfy-Org/MiniMax-H3"
"$HF_BIN" download Kijai/MiniMax-H3-experimental \
  minimax_h3_video_vae_int8_convrot.safetensors \
  --revision "$KIJAI_REVISION" --local-dir "$ROOT/Kijai/MiniMax-H3-experimental"

printf '%s  %s\n' \
  4262e4e9963c553fa00016bbe83961407a4fc0a888be95fd836c8d4f2304e48b \
  "$ROOT/MATLOWAI/minimax-h3-fused-turbo-int8-convrot/diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors" \
  35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6 \
  "$ROOT/Comfy-Org/MiniMax-H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" \
  8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48 \
  "$ROOT/Comfy-Org/MiniMax-H3/vae/minimax_h3_audio_vae_fp32.safetensors" \
  9bb2d96f218c76babd85e0611b85ca8fb330a90546c01a0005e8a58a59593410 \
  "$ROOT/Kijai/MiniMax-H3-experimental/minimax_h3_video_vae_int8_convrot.safetensors" \
  | sha256sum --check --strict
