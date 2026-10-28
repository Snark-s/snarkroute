$ErrorActionPreference='Stop'
$base='http://127.0.0.1:4317'
Write-Host 'Requesting SnarkRoute server restart'
$r=Invoke-RestMethod -Uri "$base/api/system/restart" -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 30
Write-Host ('Restart request: '+($r | ConvertTo-Json -Compress -Depth 4))
