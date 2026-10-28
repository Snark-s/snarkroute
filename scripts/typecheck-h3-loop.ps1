$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host '=== H3 adapter typecheck ==='
& pnpm --filter "./packages/adapters/h3" exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '=== H3 server typecheck ==='
& pnpm --filter "./apps/server" exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host '=== H3 studio typecheck ==='
& pnpm --filter "./apps/studio" exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'All changed H3 workspaces typecheck passed'
