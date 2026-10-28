$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'sync-h3-loop-wsl.sh') | & wsl.exe -d Ubuntu-24.04 -- bash -s
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
