$ErrorActionPreference = 'Stop'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $Repo.Path
Write-Output 'Checking SnarkRoute server TypeScript'
& pnpm --filter '@snarkroute/server' exec tsc --noEmit -p tsconfig.json
if ($LASTEXITCODE -ne 0) { throw "TypeScript check failed: $LASTEXITCODE" }
Write-Output 'TYPECHECK_OK'
