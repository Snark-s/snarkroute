#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly H3_HOME="${H3_HOME:-${HOME}/h3}"
readonly TARGET="${H3_MATLOW_MODEL_ROOT:-${H3_HOME}/models}/TenStrip/10Eros-Max"
readonly REVISION="8a198588c8870ab0d613b3492a3150d091c8c2dd"
readonly REPOSITORY="TenStrip/10Eros-Max"

[[ "${H3_ACCEPT_MODEL_LICENSE:-}" == "1" ]] || { printf 'fatal: set H3_ACCEPT_MODEL_LICENSE=1 after accepting the model licenses\n' >&2; exit 2; }
command -v hf >/dev/null || { printf 'fatal: Hugging Face hf CLI is missing\n' >&2; exit 2; }
mkdir -p "$TARGET"

# hf uses its content-addressed cache and .incomplete files, so interrupted
# transfers resume and already verified blobs are not downloaded twice.
hf download "$REPOSITORY" \
  --revision "$REVISION" \
  --local-dir "$TARGET" \
  --include '10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors' \
  --include '10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors'

printf '%s  %s\n' \
  '16249794bc0d4627a3960a6c9f32631bad267ce887c716f8e77c5356d2757ca2' \
  "$TARGET/10Eros_Max_h3_hybrid_beta5_w4a8_14gb_optimized.safetensors" \
  'a8067999c65594b462d581c02b8a0573dd42d9812a14c586150a947c13388f2e' \
  "$TARGET/10Eros_Max_h3_TURBO-hybrid_beta5_w4a8_14gb_optimized.safetensors" | sha256sum --check --strict
