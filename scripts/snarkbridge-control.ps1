[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('probe', 'launch', 'start', 'stop')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$BridgeHome,

  [string]$LogPrefix,

  [ValidateRange(1, 600)]
  [int]$LockSeconds = 120
)

# SnarkBridge lifecycle for the SnarkRoute server (apps/server/src/services/snarkbridge-local.ts).
# Ownership and health rules are SnarkBridge's own (snark_services.ps1); start is its own START_SNARKBRIDGE.ps1.
# Nothing here reads, prints or logs the tunnel credential. Output is ASCII JSON (probe/launch/stop) or tagged lines (start).
$ErrorActionPreference = 'Stop'
$bridge = (Resolve-Path -LiteralPath $BridgeHome).Path.TrimEnd('\')
. (Join-Path $bridge 'snark_services.ps1')
$registry = Get-SnarkRegistry
$python = Join-Path $bridge '.venv\Scripts\python.exe'
$server = Join-Path $bridge 'server.py'
$client = Join-Path $bridge 'tunnel-client.exe'

function Get-BridgeOwner([string]$name) {
  $port = [int]$registry.services.$name.port
  $listener = Get-SnarkListener $port
  if (-not $listener) { return [ordered]@{ port = $port; state = 'none' } }
  $ownerPid = [int]$listener.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ownerPid)
  if (-not $process) { return [ordered]@{ port = $port; state = 'none' } }
  # An elevated or other-user process hides its path from this non-elevated session: it cannot be proven ours.
  if (-not $process.ExecutablePath) { return [ordered]@{ port = $port; state = 'unverified'; pid = $ownerPid; name = [string]$process.Name } }
  try {
    if ($name -eq 'snarkbridge_mcp') {
      $owned = Assert-SnarkOwner $listener $python $server
    } else {
      $owned = Assert-SnarkOwner $listener $client
      if (-not $owned.CommandLine.Contains('snarkbridge')) { throw 'Unexpected tunnel profile owner' }
    }
    return [ordered]@{ port = $port; state = 'owned'; pid = $ownerPid; parentPid = [int]$owned.ParentProcessId; name = [string]$owned.Name }
  } catch {
    return [ordered]@{ port = $port; state = 'foreign'; pid = $ownerPid; name = [string]$process.Name; reason = $_.Exception.Message }
  }
}

function Wait-PortClosed([int]$port, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-SnarkListener $port)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return -not (Get-SnarkListener $port)
}

if ($Action -eq 'probe') {
  [ordered]@{ ok = $true; mcp = Get-BridgeOwner 'snarkbridge_mcp'; tunnel = Get-BridgeOwner 'snarkbridge_tunnel' } | ConvertTo-Json -Compress -Depth 4
  exit 0
}

if ($Action -eq 'launch') {
  # The start runs in its own hidden console, outside the SnarkRoute server's process tree: a server
  # restart does not cut it short. (Windows PowerShell started without any console exits doing nothing.)
  if (-not $LogPrefix) { throw 'LogPrefix is required for launch' }
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"' + $PSCommandPath + '"'), '-Action', 'start', '-BridgeHome', ('"' + $bridge + '"'), '-LockSeconds', $LockSeconds)
  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $bridge -WindowStyle Hidden `
    -RedirectStandardOutput ($LogPrefix + '.out.log') -RedirectStandardError ($LogPrefix + '.err.log') -PassThru
  [ordered]@{ ok = $true; pid = $process.Id } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'start') {
  try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}
  # SnarkBridge's own managed start: both components, mutex, ownership checks, bounded health waits.
  # -ResetBackoff: an explicit owner command is a fresh attempt, not a watchdog retry.
  try {
    for ($attempt = 1; ; $attempt++) {
      # A watchdog start already in progress finishes first; START itself refuses to wait on its mutex.
      $mutex = [Threading.Mutex]::new($false, 'Local\SnarkBridgeManagedStartup')
      try {
        $free = $false
        try { $free = $mutex.WaitOne([TimeSpan]::FromSeconds($LockSeconds)) } catch [Threading.AbandonedMutexException] { $free = $true }
        if ($free) { $mutex.ReleaseMutex() }
      } finally { $mutex.Dispose() }
      try {
        & (Join-Path $bridge 'START_SNARKBRIDGE.ps1') -ResetBackoff
        break
      } catch {
        # Another start took the mutex between our wait and START's own check: wait for it, then verify again.
        if ($attempt -lt 3 -and $_.Exception.Message -like 'Another SnarkBridge start is running*') { continue }
        throw
      }
    }
    Write-Output 'SNARKBRIDGE_CONTROL_START_OK'
    exit 0
  } catch {
    Write-Output ('SNARKBRIDGE_CONTROL_START_FAILED: ' + $_.Exception.Message)
    exit 1
  }
}

# stop: the same mutex as START_SNARKBRIDGE.ps1, so a running watchdog start finishes first.
$mutex = [Threading.Mutex]::new($false, 'Local\SnarkBridgeManagedStartup')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($LockSeconds)) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { throw 'lock-timeout: a SnarkBridge start is still running' }
  $tunnel = Get-BridgeOwner 'snarkbridge_tunnel'
  $mcp = Get-BridgeOwner 'snarkbridge_mcp'
  # Refuse before touching anything when a port belongs to someone else: no partial stop.
  foreach ($entry in @(@('tunnel', $tunnel), @('mcp', $mcp))) {
    $owner = $entry[1]
    if ($owner.state -eq 'unverified' -or $owner.state -eq 'foreign') {
      throw ('owner-' + $owner.state + ': ' + $entry[0] + ' port ' + $owner.port + ' is held by PID ' + $owner.pid + ' (' + $owner.name + ')')
    }
  }
  $stopped = @()
  # Tunnel first: ChatGPT loses the channel before the MCP backend disappears.
  if ($tunnel.state -eq 'owned') {
    Stop-Process -Id $tunnel.pid -Force -ErrorAction Stop
    if (-not (Wait-PortClosed $tunnel.port 15)) { throw ('port-still-open: tunnel port ' + $tunnel.port) }
    $stopped += 'tunnel'
  }
  if ($mcp.state -eq 'owned') {
    Stop-Process -Id $mcp.pid -Force -ErrorAction Stop
    # The venv python.exe is a launcher whose child owns the socket; end the launcher too when it is ours.
    $launcher = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $mcp.parentPid)
    if ($launcher -and $launcher.ExecutablePath -and
        [IO.Path]::GetFullPath($launcher.ExecutablePath) -eq [IO.Path]::GetFullPath($python) -and
        $launcher.CommandLine.Contains($server)) {
      Stop-Process -Id $launcher.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if (-not (Wait-PortClosed $mcp.port 15)) { throw ('port-still-open: mcp port ' + $mcp.port) }
    $stopped += 'mcp'
  }
  [ordered]@{ ok = $true; stopped = $stopped } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
