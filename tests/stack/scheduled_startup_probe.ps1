param([string]$BridgeRoot = 'I:/SnarkBridge')
$ErrorActionPreference = 'Stop'
. (Join-Path $BridgeRoot 'snark_services.ps1')

# Exercise action construction without registering or changing any real task.
function New-ScheduledTaskAction {
    param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
    [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('snark-task-' + [Guid]::NewGuid().ToString('N'))
$savedRegistry = $env:SNARKROUTE_PORT_REGISTRY
try {
    # Apostrophes and Unicode must survive both task argument parsing and PS5 encoding.
    $unicodeName = 'Task ' + [char]0x043C + [char]0x0430 + [char]0x0440 + "'route"
    $root = Join-Path $fixture $unicodeName
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $registryPath = Join-Path $root 'service-endpoints.json'
    [IO.File]::WriteAllText($registryPath, '{"schemaVersion":1,"host":"127.0.0.1","services":{"test":{"port":4317}}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $root 'START_SNARKBRIDGE.ps1'), '[IO.File]::WriteAllText((Join-Path $PSScriptRoot ''received.txt''), $env:SNARKROUTE_PORT_REGISTRY)', [Text.UTF8Encoding]::new($true))
    $env:SNARKROUTE_PORT_REGISTRY = $registryPath
    $resolved = Get-SnarkRegistry -PathOnly
    if ($resolved -isnot [string] -or $resolved -ne $registryPath) { throw 'Registry path resolution failed' }
    $action = New-SnarkStartupTaskAction $root
    if ($action.Arguments -notmatch '-NonInteractive -WindowStyle Hidden' -or $action.Arguments -notmatch '-EncodedCommand ([A-Za-z0-9+/=]+)$') { throw 'Task action is not hidden and encoded' }
    $payload = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
    if (-not $payload.Contains($registryPath.Replace("'", "''"))) { throw 'Canonical registry path was not safely embedded' }
    # A task-like child starts without the caller's explicit registry environment.
    Remove-Item Env:/SNARKROUTE_PORT_REGISTRY -ErrorAction SilentlyContinue
    $stdout = Join-Path $fixture 'stdout.txt'
    $stderr = Join-Path $fixture 'stderr.txt'
    $process = Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WorkingDirectory $action.WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(10000)) { throw 'Disposable task action did not complete' }
    $process.Refresh()
    if ($process.ExitCode -ne 0) { throw ('Disposable task action failed: ' + [IO.File]::ReadAllText($stderr)) }
    if ([IO.File]::ReadAllText((Join-Path $root 'received.txt')) -ne $registryPath) { throw 'Task lost its Unicode canonical registry locator' }
    [IO.File]::WriteAllText((Join-Path $root 'START_SNARKBRIDGE.ps1'), 'throw ''DISPOSABLE_STARTUP_FAILURE''', [Text.UTF8Encoding]::new($true))
    $process = Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WorkingDirectory $action.WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixture 'failure.stdout.txt') -RedirectStandardError (Join-Path $fixture 'failure.stderr.txt') -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(10000)) { throw 'Disposable failing task did not complete' }
    $process.Refresh()
    if ($null -eq $process.ExitCode -or $process.ExitCode -eq 0) { throw 'Task action concealed a startup failure' }
    $env:SNARKROUTE_PORT_REGISTRY = Join-Path $root 'missing-registry.json'
    $failed = $false
    try { New-SnarkStartupTaskAction $root | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw 'Task installation accepted a missing explicit registry' }
    Write-Output 'SCHEDULED_STARTUP_LOCATOR_PASSED'
} finally {
    if ($null -eq $savedRegistry) { Remove-Item Env:/SNARKROUTE_PORT_REGISTRY -ErrorAction SilentlyContinue }
    else { $env:SNARKROUTE_PORT_REGISTRY = $savedRegistry }
    # Only this newly created fixture can be removed; no service or user files are touched.
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedFixture) -notlike 'snark-task-*') { throw 'Unsafe fixture cleanup path' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
