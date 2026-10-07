[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BonsaiDemoPath,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port
)

$demo = (Resolve-Path -LiteralPath $BonsaiDemoPath -ErrorAction Stop).Path.TrimEnd('\')
$escapedPort = [regex]::Escape([string]$Port)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'llama-server.exe'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  $executable = [string]$_.ExecutablePath
  $insideDemo = $executable.StartsWith("$demo\", [System.StringComparison]::OrdinalIgnoreCase) -or
    $commandLine.IndexOf($demo, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $usesPort = $commandLine -match "(?:^|\s)--port\s+$escapedPort(?:\s|$)"
  $insideDemo -and $usesPort
})

foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}

[pscustomobject]@{ ok = $true; stopped = $processes.Count; port = $Port } | ConvertTo-Json -Compress
