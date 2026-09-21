param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\yue2.local.json') -Raw | ConvertFrom-Json

function Get-Yue2Health {
  try { return Invoke-RestMethod -Uri ($cfg.url + '/health') -TimeoutSec 2 }
  catch { return $null }
}

$health = Get-Yue2Health
if (-not $health) {
  $serviceWindows = Join-Path $PSScriptRoot 'integrations\yue2\service.py'
  $launcherWindows = Join-Path $PSScriptRoot 'integrations\yue2\start.sh'
  $drive = [IO.Path]::GetPathRoot($serviceWindows).Substring(0, 1).ToLowerInvariant()
  $serviceLinux = '/mnt/' + $drive + $serviceWindows.Substring(2).Replace('\', '/')
  $launcherLinux = '/mnt/' + $drive + $launcherWindows.Substring(2).Replace('\', '/')
  & wsl.exe -d $cfg.wslDistro -u $cfg.linuxUser -- bash $launcherLinux $cfg.yuePath $cfg.python ([string][int]$cfg.port) $serviceLinux | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WSL could not launch the YuE2 service.' }
}

$deadline = (Get-Date).AddMinutes(3)
do {
  Start-Sleep -Milliseconds 500
  $health = Get-Yue2Health
  if ($health -and ($health.status -eq 'ready' -or $health.status -eq 'generating')) { break }
  if ($health -and $health.status -eq 'error') { throw ('YuE2 failed to load: ' + $health.error) }
} while ((Get-Date) -lt $deadline)
if (-not $health -or ($health.status -ne 'ready' -and $health.status -ne 'generating')) {
  throw 'YuE2 did not become ready. See ~/YuE/outputs/yue2-service.log.'
}
if (-not $NoOpen) { Start-Process $cfg.url }
