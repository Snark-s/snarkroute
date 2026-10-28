$ErrorActionPreference='Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'h3-loop-preflight.sh') | & wsl.exe -d Ubuntu-24.04 -- bash -c 'tr -d "\r" | bash'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
