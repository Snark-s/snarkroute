[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BonsaiDemoPath
)

$demo = (Resolve-Path -LiteralPath $BonsaiDemoPath -ErrorAction Stop).Path
$launcher = Join-Path $demo "scripts\start_llama_server.ps1"
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "PrismML Bonsai-demo launcher was not found at: $launcher"
}

$env:BONSAI_FAMILY = "bonsai2"
$env:BONSAI_MODEL = "27B"
$env:BONSAI_HOST = "127.0.0.1"

Write-Host "Starting the user-installed PrismML Bonsai 2 runtime at http://127.0.0.1:8080/v1"
Write-Host "The official launcher selects the PrismML llama.cpp fork and enables --jinja for native tool calls."
& $launcher
exit $LASTEXITCODE
