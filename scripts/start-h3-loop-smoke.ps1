$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4317'
$admission = Invoke-RestMethod -Uri "$base/api/system/local-runtimes/h3/admission?intent=workload" -TimeoutSec 25
Write-Host ("Admission: " + ($admission | ConvertTo-Json -Compress -Depth 6))
if ($admission.allowed -eq $false -or $admission.ok -eq $false) { Write-Host 'Admission blocked H3 startup.'; exit 8 }
Write-Host 'Requesting local H3 startup through SnarkRoute supervisor...'
$response = Invoke-RestMethod -Uri "$base/api/h3/local/start" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 240
Write-Host ("Start status: " + ($response | ConvertTo-Json -Compress -Depth 5))
if ($response.ok -ne $true) { exit 9 }
