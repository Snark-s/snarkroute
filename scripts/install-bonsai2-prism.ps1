# Bonsai 2 small family installation using the official PrismML Windows demo.
# Non-destructive: refuses to update a dirty/custom demo checkout, leaves 27B
# and the existing Ollama/Qwen installation untouched.
[CmdletBinding()]
param(
  [ValidateSet("2B","4B","9B")]
  [string[]]$Sizes = @("2B","4B","9B"),
  [string]$BonsaiDemoPath = "I:\AI\Bonsai-demo",
  [switch]$SkipGitUpdate
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$DemoPath = [System.IO.Path]::GetFullPath($BonsaiDemoPath)
$Launcher = Join-Path $DemoPath "scripts\start_llama_server.ps1"
$Setup = Join-Path $DemoPath "setup.ps1"
if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) {
  throw "Official PrismML launcher not found: $Launcher"
}
if (-not (Test-Path -LiteralPath $Setup -PathType Leaf)) {
  throw "Official PrismML setup.ps1 not found: $Setup"
}
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
if (-not $SkipGitUpdate) {
  if (-not $git) { throw "Git is missing. Install Git for Windows or use -SkipGitUpdate only if the demo already supports 2B/4B/9B." }
  $origin = (& $git.Source -C $DemoPath remote get-url origin 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $origin -notmatch '(?i)(github\.com[:/])PrismML-Eng/Bonsai-demo(\.git)?$') {
    throw "Demo is not confirmed as the official PrismML-Eng/Bonsai-demo git checkout. No modifications made. Origin: $origin"
  }
  $dirty = (& $git.Source -C $DemoPath status --porcelain --untracked-files=no 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $dirty) {
    throw "Bonsai-demo contains tracked local changes. Refusing git update so no customizations are lost. Inspect git status in $DemoPath."
  }
  Write-Host "Updating official Bonsai-demo with fast-forward only ..." -ForegroundColor Cyan
  & $git.Source -C $DemoPath pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw "Official demo update failed. Existing files were not overwritten by a reset." }
}
$smallModelsDoc = Join-Path $DemoPath "SMALL-MODELS.md"
if (-not (Test-Path -LiteralPath $smallModelsDoc -PathType Leaf)) {
  throw "Bonsai-demo does not contain SMALL-MODELS.md. Need updated official scripts before installing Bonsai 2 2B/4B/9B."
}
$old = @{}
foreach ($key in @("BONSAI_FAMILY","BONSAI_MODEL","BONSAI_OPENWEBUI","BONSAI_CODE_INTERPRETER","BONSAI_SKIP_MLX")) {
  $old[$key] = [Environment]::GetEnvironmentVariable($key,"Process")
}
$env:BONSAI_FAMILY = "bonsai2"
$env:BONSAI_OPENWEBUI = "0"
$env:BONSAI_CODE_INTERPRETER = "0"
$env:BONSAI_SKIP_MLX = "1"
Push-Location -LiteralPath $DemoPath
try {
  foreach ($size in ($Sizes | Select-Object -Unique)) {
    $env:BONSAI_MODEL = $size
    Write-Host ""
    Write-Host ("Installing official Ternary Bonsai 2 " + $size + " ...") -ForegroundColor Cyan
    # The official setup downloads only the selected model, reusing already installed components.
    & $Setup
    if ($LASTEXITCODE -ne 0) { throw "Official setup.ps1 failed for Bonsai 2 $size, exit $LASTEXITCODE" }
    $filename = "Ternary-Bonsai-2-$size-PQ2_0.gguf"
    $model = Get-ChildItem -LiteralPath (Join-Path $DemoPath "models") -Recurse -File -Filter $filename -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -gt 100MB } | Select-Object -First 1
    if (-not $model) { throw "Setup finished but $filename was not found as a complete GGUF under $DemoPath\models." }
    Write-Host "Verified model file: $($model.FullName) ($([math]::Round($model.Length / 1GB, 2)) GiB)" -ForegroundColor Green
  }
} finally {
  Pop-Location
  foreach ($key in $old.Keys) {
    [Environment]::SetEnvironmentVariable($key,$old[$key],"Process")
  }
}
Write-Host ""
Write-Host "Bonsai 2 small weights installed using PrismML fork. No model was started." -ForegroundColor Green
Write-Host "Next: run one model at a time and check /v1/models + correct text/tool_calls before enabling autonomous agents."
