$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\yue2.local.json') -Raw | ConvertFrom-Json
try { Invoke-RestMethod -Uri ($cfg.url + '/health') -TimeoutSec 2 | Out-Null }
catch { exit 0 }
try {
  Invoke-RestMethod -Uri ($cfg.url + '/shutdown') -Method Post -TimeoutSec 3 | Out-Null
  $deadline = (Get-Date).AddSeconds(35)
  do {
    Start-Sleep -Milliseconds 300
    try { Invoke-RestMethod -Uri ($cfg.url + '/health') -TimeoutSec 1 | Out-Null; $online = $true }
    catch { $online = $false }
  } while ($online -and (Get-Date) -lt $deadline)
  if ($online) { throw 'YuE2 service did not stop within 35 seconds.' }
} catch { throw }
