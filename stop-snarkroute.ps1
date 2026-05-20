$ErrorActionPreference = "SilentlyContinue"

$root = (Resolve-Path $PSScriptRoot).Path
$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 4317 }
$studioPort = if ($env:STUDIO_PORT) { [int]$env:STUDIO_PORT } else { 5173 }
$snarkroutePort = if ($env:SNARKROUTE_PORT) { [int]$env:SNARKROUTE_PORT } else { 5174 }
$ports = @(
  $apiPort,
  $studioPort,
  $snarkroutePort
) | Sort-Object -Unique

$currentPid = $PID
$allProcesses = @(Get-CimInstance Win32_Process)
$targets = New-Object "System.Collections.Generic.HashSet[int]"
$netstatTargets = New-Object "System.Collections.Generic.HashSet[int]"

function Add-Target([int]$processId) {
  if ($processId -gt 0 -and $processId -ne $currentPid) {
    [void]$targets.Add($processId)
  }
}

function Add-ProcessFamily([int]$processId) {
  Add-Target $processId

  $process = $allProcesses | Where-Object { $_.ProcessId -eq $processId } | Select-Object -First 1
  while ($process -and $process.ParentProcessId -and $process.ParentProcessId -ne $currentPid) {
    $parent = $allProcesses | Where-Object { $_.ProcessId -eq $process.ParentProcessId } | Select-Object -First 1
    if (!$parent) { break }
    if ($parent.Name -notmatch "^(cmd|node|powershell|pwsh)\.exe$") { break }
    Add-Target ([int]$parent.ProcessId)
    $process = $parent
  }
}

foreach ($port in $ports) {
  $netstatLines = @(netstat -ano -p tcp | Select-String -Pattern "[:.]$port\s+.*LISTENING\s+(\d+)")
  foreach ($line in $netstatLines) {
    $match = [regex]::Match($line.Line, "\s(\d+)\s*$")
    if ($match.Success) {
      $pidFromNetstat = [int]$match.Groups[1].Value
      [void]$netstatTargets.Add($pidFromNetstat)
      Add-ProcessFamily $pidFromNetstat
    }
  }

  $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen)
  foreach ($connection in $connections) {
    Add-ProcessFamily ([int]$connection.OwningProcess)
  }
}

$escapedRoot = [regex]::Escape($root)
$projectProcesses = $allProcesses | Where-Object {
  $_.CommandLine -and
  ($_.CommandLine -match $escapedRoot -or $_.CommandLine -match "snarkroute|boojumroute") -and
  $_.Name -match "^(cmd|node|powershell|pwsh)\.exe$"
}

foreach ($process in $projectProcesses) {
  Add-Target ([int]$process.ProcessId)
}

$windowProcesses = Get-Process | Where-Object {
  $_.MainWindowTitle -match "SnarkRoute|BoojumRoute"
}

foreach ($process in $windowProcesses) {
  Add-Target ([int]$process.Id)
}

$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $allProcesses) {
    if ($targets.Contains([int]$process.ParentProcessId) -and !$targets.Contains([int]$process.ProcessId) -and [int]$process.ProcessId -ne $currentPid) {
      Add-Target ([int]$process.ProcessId)
      $changed = $true
    }
  }
}

$targetIds = foreach ($id in $targets) { $id }
$targetIds = @($targetIds) | Sort-Object -Unique
if ($targetIds.Count -eq 0) {
  Write-Host "No SnarkRoute services found."
  exit 0
}

Write-Host ("Stopping process id(s): " + ($targetIds -join ", "))
foreach ($id in $netstatTargets) {
  taskkill /PID $id /T /F | Out-Null
}
foreach ($id in ($targetIds | Where-Object { !$netstatTargets.Contains([int]$_) } | Sort-Object -Descending)) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

taskkill /FI "WINDOWTITLE eq SnarkRoute API*" /T /F | Out-Null
taskkill /FI "WINDOWTITLE eq BoojumRoute Lab*" /T /F | Out-Null
