param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config\yue2.local.json') -Raw | ConvertFrom-Json

function Get-Yue2Health {
  try { return Invoke-RestMethod -Uri ($cfg.url + '/health') -TimeoutSec 2 }
  catch { return $null }
}

function Invoke-Yue2Wsl {
  param([Parameter(Mandatory=$true)][string[]]$Arguments)
  $output = (& wsl.exe @Arguments 2>&1 | Out-String).Trim()
  $exit = $LASTEXITCODE
  if ($exit -ne 0) {
    $detail = if ($output) { "`nWSL output:`n$output" } else { '' }
    throw "WSL command failed with exit code $exit.$detail"
  }
  return $output
}

$health = Get-Yue2Health
if (-not $health) {
  $serviceWindows = Join-Path $PSScriptRoot 'integrations\yue2\service.py'
  $launcherWindows = Join-Path $PSScriptRoot 'integrations\yue2\start.sh'
  $drive = [IO.Path]::GetPathRoot($serviceWindows).Substring(0, 1).ToLowerInvariant()
  $serviceLinux = '/mnt/' + $drive + $serviceWindows.Substring(2).Replace('\', '/')
  $launcherLinux = '/mnt/' + $drive + $launcherWindows.Substring(2).Replace('\', '/')
  $args = @('-d', $cfg.wslDistro, '-u', $cfg.linuxUser, '--', 'bash', $launcherLinux, $cfg.yuePath, $cfg.python, ([string][int]$cfg.port), $serviceLinux)
  [void](Invoke-Yue2Wsl -Arguments $args)
}

$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $health = Get-Yue2Health
  if ($health -and ($health.status -eq 'loading' -or $health.status -eq 'ready' -or $health.status -eq 'generating')) { break }
  if ($health -and $health.status -eq 'error') { throw ('YuE2 failed to load: ' + $health.error) }
} while ((Get-Date) -lt $deadline)

if (-not $health -or ($health.status -ne 'loading' -and $health.status -ne 'ready' -and $health.status -ne 'generating')) {
  $tail = ''
  try {
    $logPath = ($cfg.yuePath.TrimEnd('/') + '/outputs/yue2-service.log')
    $tailArgs = @('-d', $cfg.wslDistro, '-u', $cfg.linuxUser, '--', 'tail', '-n', '60', $logPath)
    $tail = Invoke-Yue2Wsl -Arguments $tailArgs
  } catch {
    $tail = 'Could not read YuE2 service log: ' + $_.Exception.Message
  }
  $detail = if ($tail) { "`nLast YuE2 service log lines:`n$tail" } else { '' }
  throw "YuE2 service did not appear within 60 seconds.$detail"
}

if (-not $NoOpen) { Start-Process $cfg.url }
