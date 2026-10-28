$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Write-Host "=== Installed H3 WSL files (no secrets) ==="
$bash = @'
set -e
p=/home/serge/h3/runtime/snarkroute-h3
echo "Worker directory: $p"
for f in app/backends/h3_cyclic.py app/backends/matlow_runtime.py app/models.py scripts/matlow_reference_smoke.py scripts/start_local_wsl.sh; do
 if [ -e "$p/$f" ]; then stat -c "%n (%s bytes, %y)" "$p/$f"; else echo "MISSING $f"; fi
done
echo "Runtime python:"
ls -l /home/serge/h3/runtime/sglang-venv/bin/python "$p/.venv/bin/python" 2>/dev/null || true
echo "Runtime state:"
if [ -f /home/serge/h3/runtime/local/worker.pid ]; then cat /home/serge/h3/runtime/local/worker.pid; fi
echo "Memory:"
free -h | head -n 3
'@
Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'inspect-h3-loop-runtime.sh') | & wsl.exe -d Ubuntu-24.04 -- bash -s
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
