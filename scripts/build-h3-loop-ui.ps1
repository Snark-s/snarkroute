$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host 'H3 server queue/session tests'
& pnpm --filter './apps/server' exec vitest run src/services/h3-queue.test.ts src/services/h3-session-runtime.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'H3 Studio build'
& pnpm --filter './apps/studio' build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'H3 queue tests and Studio build passed'
