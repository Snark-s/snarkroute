$ErrorActionPreference = 'Stop'
$r=Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/h3/local/stop' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 160
Write-Host ('H3 stop: '+($r | ConvertTo-Json -Depth 4 -Compress))
