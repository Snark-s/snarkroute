#!/usr/bin/env bash
set -eu
yue_root=$1
yue_python=$2
yue_port=$3
yue_service=$4
cd "$yue_root"
mkdir -p outputs
exec > outputs/yue2-launcher.log 2>&1
if [[ ! -x "$yue_python" ]]; then
  printf 'YuE2 Python is not executable: %s\n' "$yue_python"
  exit 2
fi
if [[ ! -f "$yue_service" ]]; then
  printf 'YuE2 service script is missing: %s\n' "$yue_service"
  exit 3
fi
nohup env YUE2_HOME="$yue_root" YUE2_PORT="$yue_port" "$yue_python" "$yue_service" \
  > outputs/yue2-service.log 2>&1 < /dev/null &
printf '%s\n' "$!" > outputs/yue2-service.pid
sleep .5
if ! kill -0 "$!" 2>/dev/null; then
  printf 'YuE2 service exited during startup.\n'
  tail -40 outputs/yue2-service.log
  exit 4
fi
