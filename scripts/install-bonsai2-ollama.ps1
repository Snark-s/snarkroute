# Install the four official Bonsai 2 models into the existing local Ollama library.
# Downloads model weights only; never starts four competing GPU residents or changes existing models.
[CmdletBinding()]
param(
  [ValidateSet("2b", "4b", "9b", "27b")]
  [string[]]$Sizes = @("2b", "4b", "9b", "27b"),
  [switch]$SmokeTest,
  [switch]$AllowExperimentalOllama
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $AllowExperimentalOllama) {
  throw "Bonsai 2 Ollama installation is experimental: regular Ollama may load Q2_0 without PrismML Hadamard transforms and return incorrect text. Use the PrismML llama.cpp fork instead. To test at your own risk, explicitly pass -AllowExperimentalOllama after updating Ollama to 0.40.6 or newer; validate real answers before using agents."
}
$ProgressPreference = "SilentlyContinue"
$base = "http://127.0.0.1:11434"
$ollama = Get-Command "ollama.exe" -ErrorAction SilentlyContinue
if (-not $ollama) { $ollama = Get-Command "ollama" -ErrorAction SilentlyContinue }
if (-not $ollama) { throw "Ollama CLI not found. Install Ollama, start its local server and retry." }

try {
  $null = Invoke-RestMethod -Uri "$base/api/version" -TimeoutSec 8
} catch {
  throw "Ollama on 127.0.0.1:11434 is not responding. Start the existing Ollama service first."
}

foreach ($size in ($Sizes | Select-Object -Unique)) {
  $model = "bonsai-2:$size"
  Write-Host "Installing $model ..."
  & $ollama.Source pull $model
  if ($LASTEXITCODE -ne 0) { throw "ollama pull failed for $model (exit code $LASTEXITCODE)." }

  $tags = Invoke-RestMethod -Uri "$base/api/tags" -TimeoutSec 15
  $installed = @($tags.models | ForEach-Object { $_.name })
  if ($installed -notcontains $model) { throw "$model was not found in Ollama /api/tags after pull." }
  Write-Host "Installed: $model"

  if ($SmokeTest) {
    Write-Host "Testing $model (single short prompt, no persistent residency)..."
    $body = @{ model = $model; prompt = "Reply with one word: ready"; stream = $false;
      keep_alive = 0; think = $false; options = @{ num_ctx = 2048; num_predict = 256 } } | ConvertTo-Json -Depth 5
    $response = Invoke-RestMethod -Uri "$base/api/generate" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 300
    if (-not $response.done -or -not $response.response) { throw "$model did not return a usable answer." }
    Write-Host "Inference OK: $model"
  }
}
Write-Host "Bonsai 2 files installed. Restart SnarkRoute so its updated local model discovery is active."
