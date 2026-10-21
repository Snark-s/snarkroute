# Wait for download.ps1 to finish, then run the smoke once if the download succeeded.
$root = $PSScriptRoot
$done = Join-Path $root 'results\download-done.txt'
while (-not (Test-Path $done)) { Start-Sleep 20 }
$state = Get-Content $done -Raw
if ($state -match '^DONE') { & (Join-Path $root 'smoke-run.ps1') }
else { "SKIPPED smoke: $state" | Set-Content (Join-Path $root 'results\smoke-done.txt') }
