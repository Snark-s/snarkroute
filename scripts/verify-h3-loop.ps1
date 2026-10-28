# H3 Loop: focused owner-approved development checks.
# This script runs only fixed local commands in the SnarkRoute checkout.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host "=== H3 adapter Loop tests ==="
& pnpm --filter "@snarkroute/h3" exec vitest run test/loop.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "=== H3 adapter TypeScript ==="
& pnpm --filter "@snarkroute/h3" exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "=== H3 Python Loop CPU tests ==="
Push-Location "workers/minimax-h3"
try {
  & python -m pytest tests/test_h3_cyclic.py -q
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
Write-Host "H3 Loop focused checks passed."
