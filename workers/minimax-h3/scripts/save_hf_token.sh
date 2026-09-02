#!/usr/bin/env bash
set -euo pipefail

token_file="${HF_TOKEN_FILE:-/workspace/snarkroute-h3/.hf.env}"
umask 077

read -rsp "HF token: " hf_token
printf '\n'

if [[ -z "$hf_token" ]]; then
  echo "Токен не сохранён: введено пустое значение." >&2
  exit 1
fi

printf 'HF_TOKEN=%s\n' "$hf_token" > "$token_file"
chmod 600 "$token_file"
unset hf_token

echo "Токен сохранён."
