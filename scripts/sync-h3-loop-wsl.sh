#!/usr/bin/env bash
set -euo pipefail
source_dir='/mnt/y/Процесс/SnarkRoute/workers/minimax-h3'
target_dir='/home/serge/h3/runtime/snarkroute-h3'
if [ ! -f "$source_dir/app/backends/h3_cyclic.py" ]; then
  echo 'Windows source not mounted; refusing sync'
  exit 4
fi
if [ ! -f "$target_dir/app/backends/matlow_runtime.py" ]; then
  echo 'Installed H3 worker not found; refusing sync'
  exit 5
fi
backup="/home/serge/h3/runtime/local/backup_loop_$(date +%Y%m%d_%H%M%S)"
for f in app/backends/h3_cyclic.py app/backends/matlow_runtime.py app/backends/matlow_int8.py app/backends/sglang.py app/models.py; do
  mkdir -p "$backup/$(dirname "$f")"
  if test -f "$target_dir/$f"; then cp -p "$target_dir/$f" "$backup/$f"; fi
done
echo "Backup at $backup"
for f in app/backends/h3_cyclic.py app/backends/matlow_runtime.py app/backends/matlow_int8.py app/backends/sglang.py app/models.py; do
  cp -v "$source_dir/$f" "$target_dir/$f"
done
"$target_dir/.venv/bin/python" -m compileall -q "$target_dir/app"
echo 'Worker Python syntax OK'
exit 0
