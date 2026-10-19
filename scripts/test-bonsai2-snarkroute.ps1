# Read-only Bonsai 2 runtime smoke test: text generation, native tools and SnarkRoute catalog.
[CmdletBinding()]
param(
  [string]$BaseUrl = "http://127.0.0.1:8081",
  [string]$SnarkRouteUrl = "http://127.0.0.1:4317"
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
function Post-Chat([hashtable]$payload) {
  $json = $payload | ConvertTo-Json -Depth 14 -Compress
  return Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/chat/completions" -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -ContentType "application/json; charset=utf-8" -TimeoutSec 240
}
Write-Host "1. Discovering actual GGUF identity..." -ForegroundColor Cyan
$list = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 10
$ids = @($list.data | ForEach-Object { $_.id })
if ($ids.Count -eq 0) { throw "The inference server returned no models." }
$model = [string]$ids[0]
if ($model -notmatch "Bonsai[-_]?2[-_:]?(2|4|9|27)B") {
  throw "This server is not serving a recognized Bonsai 2 size: $model"
}
Write-Host "Model: $model"
Write-Host "2. Testing real text generation..." -ForegroundColor Cyan
$textResult = Post-Chat @{
  model = $model
  messages = @(@{ role = "user"; content = "Чему равно 17 умножить на 23? Ответь только числом." })
  chat_template_kwargs = @{ enable_thinking = $false }
  temperature = 0.7
  top_p = 0.8
  presence_penalty = 1.5
  stream = $false
  max_tokens = 2048
}
$message = $textResult.choices[0].message
$text = [string]$message.content
Write-Host "Answer: $text"
if ($text -match "391") {
  Write-Host "Text response: PASS" -ForegroundColor Green
} else {
  Write-Warning "Text response not verified. Inspect full assistant message below."
  $message | ConvertTo-Json -Depth 10 | Write-Host
}
Write-Host "3. Testing OpenAI-format tool calling..." -ForegroundColor Cyan
$toolResult = Post-Chat @{
  model = $model
  messages = @(
    @{ role = "system"; content = "You can call add_numbers to add integers. When asked to add numbers, call the tool. Do not answer directly." },
    @{ role = "user"; content = "Call add_numbers with a=17 and b=23." }
  )
  tools = @(@{
    type = "function"
    function = @{
      name = "add_numbers"
      description = "Add two integers."
      parameters = @{
        type = "object"
        properties = @{
          a = @{ type = "integer" }
          b = @{ type = "integer" }
        }
        required = @("a","b")
      }
    }
  })
  tool_choice = "auto"
  chat_template_kwargs = @{ enable_thinking = $false }
  temperature = 0.7
  top_p = 0.8
  presence_penalty = 1.5
  stream = $false
  max_tokens = 2048
}
$toolMessage = $toolResult.choices[0].message
$calls = @()
if ($toolMessage.PSObject.Properties.Name -contains "tool_calls") {
  $calls = @($toolMessage.tool_calls | Where-Object { $_ })
}
if ($calls.Count -eq 0) {
  Write-Warning "No structured tool_calls returned. Tool use is NOT verified."
  $toolMessage | ConvertTo-Json -Depth 12 | Write-Host
} else {
  $calls | ConvertTo-Json -Depth 12 | Write-Host
  $valid = @($calls | Where-Object { $_.function.name -eq "add_numbers" }).Count -gt 0
  if ($valid) { Write-Host "Structured tool call: PASS (arguments still require validation)" -ForegroundColor Green }
  else { Write-Warning "Wrong tool name returned." }
}
Write-Host "4. Checking SnarkRoute model catalog..." -ForegroundColor Cyan
try {
  $catalog = Invoke-RestMethod -Uri "$SnarkRouteUrl/api/models/v1?provider=local_openai" -TimeoutSec 15
  $entries = @($catalog.models | Where-Object { $_.providerModelId -eq $model })
  if ($entries.Count -gt 0) {
    Write-Host ("SnarkRoute catalog: PASS (" + $entries[0].displayName + ")") -ForegroundColor Green
  } else {
    Write-Warning "This physical GGUF ID is not yet shown in SnarkRoute. Restart/rebuild its server after code edits."
    @($catalog.models | Select-Object displayName,providerModelId) | Format-Table | Out-String | Write-Host
  }
} catch {
  Write-Warning "SnarkRoute catalog request failed: $($_.Exception.Message)"
}
Write-Host "Test finished. No model files, services or settings were changed." -ForegroundColor Cyan
