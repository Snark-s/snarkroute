$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host 'H3 Studio TypeScript check'
& pnpm --filter './apps/studio' exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Studio TypeScript OK'
Write-Host 'Focused H3 adapter tests'
& pnpm --filter './packages/adapters/h3' exec vitest run test/loop.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'H3 Studio and adapter checks complete'
