# Read-only Bonsai 2 smoke tests, including an actual tool-result round-trip.
[CmdletBinding()]
param([string]$BaseUrl = "http://127.0.0.1:8081", [switch]$IncludeThinking)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-BonsaiChat([object[]]$messages, [object[]]$tools, [bool]$thinking, [int]$limit) {
  $payload = @{
    model = $script:Model
    messages = $messages
    stream = $false
    max_tokens = $limit
    temperature = $(if ($thinking) { 1.0 } else { 0.7 })
    top_p = $(if ($thinking) { 0.95 } else { 0.8 })
    top_k = 20
    min_p = 0.0
    presence_penalty = $(if ($thinking) { 1.0 } else { 1.5 })
    repeat_penalty = 1.0
    repeat_last_n = 64
    chat_template_kwargs = @{ enable_thinking = $thinking }
  }
  if ($tools.Count -gt 0) { $payload.tools = $tools; $payload.tool_choice = "auto" }
  $body = $payload | ConvertTo-Json -Depth 14 -Compress
  $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/chat/completions" -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 240
  if (-not $response.choices -or -not $response.choices[0].message) { throw "Missing assistant message." }
  return $response.choices[0].message
}
$models = Invoke-RestMethod -Uri "$BaseUrl/v1/models" -TimeoutSec 10
$script:Model = [string]@($models.data)[0].id
if ($script:Model -notmatch '(?i)bonsai[-_]?2[-_:]?(2|4|9|27)b') { throw "Unexpected model $script:Model" }
Write-Host "Model: $script:Model" -ForegroundColor Cyan
$passes = 0
$total = 0
$cases = @(
  @{ name = "Russian multiplication"; prompt = "Вычисли 17 умножить на 23. Ответь только числом."; expected = "391" },
  @{ name = "English multiplication"; prompt = "Calculate 17 times 23. Reply with the single integer only."; expected = "391" },
  @{ name = "Simple addition"; prompt = "Вычисли 17 плюс 23. Ответь только числом."; expected = "40" },
  @{ name = "Instruction following"; prompt = "Ответь одним словом КЕДР. Ничего больше."; expected = "КЕДР" }
)
foreach ($case in $cases) {
  $total++
  try {
    $message = Invoke-BonsaiChat @(@{ role = "user"; content = $case.prompt }) @() $false 512
    $got = [string]$message.content
    if ($got.Trim() -ceq $case.expected) { $passes++; Write-Host ("PASS " + $case.name + ": " + $got.Trim()) -ForegroundColor Green }
    else {
      $brief = ($got -replace '\s+', ' ').Trim()
      if ($brief.Length -gt 360) { $brief = $brief.Substring(0, 360) + " ..." }
      Write-Host ("FAIL " + $case.name + " | expected=" + $case.expected + " | got=" + $brief) -ForegroundColor Yellow
    }
  } catch { Write-Host ("ERROR " + $case.name + ": " + $_.Exception.Message) -ForegroundColor Red }
}
if ($IncludeThinking) {
  $total++
  try {
    $message = Invoke-BonsaiChat @(@{ role = "user"; content = "Calculate 17 times 23. Answer with only the integer." }) @() $true 4096
    $got = ([string]$message.content).Trim()
    if ($got -eq "391") { $passes++; Write-Host "PASS Thinking-on multiplication" -ForegroundColor Green }
    else {
      $brief = ($got -replace '\s+', ' ').Trim()
      if ($brief.Length -gt 360) { $brief = $brief.Substring(0, 360) + " ..." }
      Write-Host ("FAIL Thinking-on multiplication | got=" + $brief) -ForegroundColor Yellow
    }
  } catch { Write-Host ("ERROR Thinking-on multiplication: " + $_.Exception.Message) -ForegroundColor Red }
}
Write-Host "Native tool round-trip..." -ForegroundColor Cyan
$total++
try {
  $messages = @(
    @{ role = "system"; content = "You have a multiply tool. When multiplying two integers, call multiply, wait for its result, then return ONLY the numeric tool result." },
    @{ role = "user"; content = "Multiply 17 by 23 using multiply." }
  )
  $tools = @(@{
    type = "function"
    function = @{
      name = "multiply"
      description = "Multiply two integer values a and b."
      parameters = @{
        type = "object"
        properties = @{ a = @{ type = "integer" }; b = @{ type = "integer" } }
        required = @("a", "b")
      }
    }
  })
  $first = Invoke-BonsaiChat $messages $tools $false 1024
  $calls = @()
  if ($first.PSObject.Properties.Name -contains "tool_calls") { $calls = @($first.tool_calls | Where-Object { $_ }) }
  if ($calls.Count -ne 1) { throw "Expected one tool call, received $($calls.Count)." }
  $call = $calls[0]
  if ($call.function.name -ne "multiply") { throw "Wrong tool name: $($call.function.name)" }
  $arguments = [string]$call.function.arguments | ConvertFrom-Json
  if ([int]$arguments.a -ne 17 -or [int]$arguments.b -ne 23) { throw "Wrong arguments: $($call.function.arguments)" }
  if (-not $call.id) { throw "No tool_call id." }
  $computed = [string]([int]$arguments.a * [int]$arguments.b)
  $messages += $first
  $messages += @{ role = "tool"; tool_call_id = [string]$call.id; name = "multiply"; content = $computed }
  $second = Invoke-BonsaiChat $messages $tools $false 1024
  $got = ([string]$second.content).Trim()
  if ($got -eq $computed) {
    $passes++
    Write-Host "PASS Tool round-trip: args=(17,23), result=391, final=391" -ForegroundColor Green
  } else {
    $brief = ($got -replace '\s+', ' ').Trim()
    if ($brief.Length -gt 300) { $brief = $brief.Substring(0, 300) + " ..." }
    Write-Host ("FAIL Tool round-trip: tool arguments correct, final answer=" + $brief) -ForegroundColor Yellow
  }
} catch { Write-Host ("FAIL Tool round-trip: " + $_.Exception.Message) -ForegroundColor Yellow }
Write-Host "Summary: $passes/$total checks passed. One run does not establish agent reliability." -ForegroundColor Cyan
