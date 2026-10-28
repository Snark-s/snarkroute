$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4317'
$before = Invoke-RestMethod -Uri "$base/api/h3/queue" -TimeoutSec 15
if ($before.session.status -notin @('idle','completed','completed_with_errors','failed','cancelled')) {
  throw "Queue session not idle: $($before.session.status)"
}
$body = @{
 title = '__H3_LOOP_SMOKE_DELETE__'
 operation = 'text_to_video'
 prompt = 'A still sea, softly moving jellyfish, seamless motion.'
 duration = 5
 aspectRatio = '16:9'
 variants = 1
 renderMode = 'preview'
 modelVariant = 'h3_base'
 inferenceSteps = 4
 seamlessLoop = $true
} | ConvertTo-Json -Compress
$created = $null
try {
 $created = Invoke-RestMethod -Uri "$base/api/h3/queue" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
 $after = Invoke-RestMethod -Uri "$base/api/h3/queue" -TimeoutSec 15
 $item = $after.items | Where-Object { $_.id -eq $created.id } | Select-Object -First 1
 if ($null -eq $item) { throw 'Queue smoke item missing after write' }
 if ($item.seamlessLoop -ne $true) { throw 'Queue discarded seamlessLoop flag' }
 Write-Host "Queue roundtrip OK: seamlessLoop=$($item.seamlessLoop) (ID hidden)"
} finally {
 if ($created -and $created.id) {
  Invoke-RestMethod -Uri "$base/api/h3/queue/$($created.id)" -Method Delete -TimeoutSec 15 | Out-Null
  Write-Host 'Smoke item removed'
 }
}
