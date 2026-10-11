[CmdletBinding()]
param(
  [string]$BonsaiDemoPath
)

$registryPath = $env:SNARKROUTE_PORT_REGISTRY
if (-not $registryPath) { $registryPath = Join-Path (Split-Path $PSScriptRoot) 'service-endpoints.json' }
$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
if ($registry.schemaVersion -ne 1 -or $registry.host -ne '127.0.0.1') { throw 'Invalid service endpoint registry.' }
$base = 'http://127.0.0.1:' + $registry.services.snarkroute.port
$health = Invoke-RestMethod -Uri ($base + '/health') -TimeoutSec 3 -MaximumRedirection 0
if ($health.service -ne 'snarkroute-server' -or $health.apiVersion -ne 1 -or $health.ok -ne $true) {
  throw 'Configured port is not a compatible SnarkRoute API.'
}
if ($BonsaiDemoPath) {
  Write-Host 'Configure BONSAI_DEMO_PATH in SnarkRoute; the runtime supervisor owns Bonsai startup.'
}
# SnarkRoute performs service identity and GPU admission before launching.
$result = Invoke-RestMethod -Method Post -Uri ($base + '/api/system/bonsai/start') -TimeoutSec 30 -MaximumRedirection 0
$result | ConvertTo-Json -Depth 3
