$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$registryPath = $env:SNARKROUTE_PORT_REGISTRY
if (-not $registryPath) { $registryPath = Join-Path $repository 'service-endpoints.json' }
$registry = [IO.File]::ReadAllText($registryPath) | ConvertFrom-Json
. (Join-Path $registry.paths.snarkbridge 'snark_services.ps1')
$nowSeconds = 1791723000
function New-HealthReport($timestamp) {
    return @{ result='ok'; healthz=@{ok=$true}; readyz=@{ok=$true}; control_plane_poll=@{ok=$true;value=$timestamp} }
}
if (-not (Test-SnarkTunnelHealthReport (New-HealthReport ($nowSeconds - 30)) $nowSeconds)) { throw 'Recent poll rejected' }
foreach ($timestamp in @(($nowSeconds - 14 * 3600), $null, $false, 'invalid', 0, ($nowSeconds + 600))) {
    if (Test-SnarkTunnelHealthReport (New-HealthReport $timestamp) $nowSeconds) { throw 'Stale/invalid poll accepted' }
}
Write-Output 'TUNNEL_FRESHNESS_POWERSHELL_PASS: recent allowed; stale/missing/invalid/future rejected'
