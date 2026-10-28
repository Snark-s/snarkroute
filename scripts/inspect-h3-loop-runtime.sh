#!/usr/bin/env bash
set -euo pipefail
p=/home/serge/h3/runtime/snarkroute-h3
echo "Worker dir $p"
for f in app/backends/h3_cyclic.py app/backends/matlow_runtime.py app/models.py scripts/matlow_reference_smoke.py scripts/start_local_wsl.sh; do
 if test -e "$p/$f"; then stat -c '%n (%s bytes)' "$p/$f"; else echo "MISSING $f"; fi
done
echo "Runtime Python:"
ls -l /home/serge/h3/runtime/sglang-venv/bin/python "$p/.venv/bin/python" 2>/dev/null || true
echo "Memory:"
free -h | head -n 3
