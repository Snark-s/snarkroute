#!/usr/bin/env bash
# Stop the local SGLang and H3 API processes without deleting models or results.

set -Eeuo pipefail

readonly H3_HOME="${H3_HOME:-${HOME}/h3}"
readonly RUNTIME_DIR="${H3_HOME}/runtime/local"
readonly APP_DIR="${H3_APP_DIR:-${H3_HOME}/runtime/snarkroute-h3}"

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

for name in h3-api sglang; do
  pid_file="${RUNTIME_DIR}/${name}.pid"
  [[ -f "$pid_file" ]] || continue
  pid="$(<"$pid_file")"
  if pid_is_h3_process "$pid" "$name"; then
    kill "$pid"
    for _ in {1..30}; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  fi
  rm -f -- "$pid_file"
done

printf 'Local H3 processes are stopped. Models and results were kept.\n'
