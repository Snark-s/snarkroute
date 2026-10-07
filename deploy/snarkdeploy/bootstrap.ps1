param(
  [string]$Bundle = "",
  [string]$ProcessRoot = "",
  [string]$AppsRoot = "",
  [string]$AiRoot = "",
  [string]$PersonaHome = ""
)
$ErrorActionPreference = "Stop"

function Say([string]$Text) { Write-Host "[SnarkDeploy] $Text" }
function Has([string]$Command) { return [bool](Get-Command $Command -ErrorAction SilentlyContinue) }
function Install-Winget([string]$Id) {
  Say "Installing $Id"
  winget install --id $Id -e --accept-source-agreements --accept-package-agreements
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Has "winget")) { throw "winget is required. Install Microsoft App Installer first." }
if (-not (Has "git")) { Install-Winget "Git.Git" }
if (-not (Has "python") -and -not (Has "py")) { Install-Winget "Python.Python.3.11" }
if (-not (Has "node")) { Install-Winget "OpenJS.NodeJS.LTS" }
Refresh-Path

if (-not (Has "corepack")) {
  Say "Installing Corepack"
  npm install -g corepack
  Refresh-Path
}
if (-not (Has "uv")) {
  Install-Winget "astral-sh.uv"
  Refresh-Path
}
if (-not (Has "ffmpeg")) {
  Install-Winget "Gyan.FFmpeg"
  Refresh-Path
}
if (-not (Has "ollama")) {
  Install-Winget "Ollama.Ollama"
  Refresh-Path
}

if ([string]::IsNullOrWhiteSpace($ProcessRoot)) {
  if (Test-Path "Y:\") { $ProcessRoot="Y:\Процесс" } else { $ProcessRoot="C:\Snark\Process" }
}
if ([string]::IsNullOrWhiteSpace($AppsRoot)) {
  if (Test-Path "Y:\") { $AppsRoot="Y:\Приложения" } else { $AppsRoot="C:\Snark\Apps" }
}
if ([string]::IsNullOrWhiteSpace($AiRoot)) {
  if (Test-Path "I:\") { $AiRoot="I:\AI" } else { $AiRoot="C:\Snark\AI" }
}
if ([string]::IsNullOrWhiteSpace($PersonaHome)) {
  if (Test-Path "I:\") { $PersonaHome="I:\PersonaCore" } else { $PersonaHome="C:\Snark\PersonaCore" }
}

$variables = @{
  "SNARK_PROCESS_ROOT" = $ProcessRoot
  "SNARK_APPS_ROOT" = $AppsRoot
  "SNARK_AI_ROOT" = $AiRoot
  "PERSONA_HOME" = $PersonaHome
}
foreach ($pair in $variables.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($pair.Key,$pair.Value,"User")
  Set-Item -Path "Env:$($pair.Key)" -Value $pair.Value
}

$Repo=Join-Path $ProcessRoot "SnarkRoute"
New-Item -ItemType Directory -Force -Path $ProcessRoot | Out-Null
New-Item -ItemType Directory -Force -Path $AppsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $AiRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $PersonaHome -Parent) | Out-Null

if (-not (Test-Path (Join-Path $Repo ".git"))) {
  Say "Cloning SnarkRoute"
  git clone https://github.com/Snark-s/snarkroute.git $Repo
}

$Deploy=Join-Path $Repo "deploy\snarkdeploy\snarkdeploy.py"
function Run-Deploy([Parameter(ValueFromRemainingArguments=$true)][string[]]$DeployArgs) {
  if (Has "python") { & python $Deploy @DeployArgs } else { & py -3 $Deploy @DeployArgs }
  if ($LASTEXITCODE -ne 0) { throw "SnarkDeploy failed: $($DeployArgs -join ' ')" }
}

if (-not [string]::IsNullOrWhiteSpace($Bundle)) {
  Run-Deploy verify $Bundle
  Run-Deploy restore $Bundle
}
Run-Deploy install

$Registry=Join-Path $env:LOCALAPPDATA "SnarkRoute\service-registry.json"
[Environment]::SetEnvironmentVariable("SNARK_SERVICE_REGISTRY",$Registry,"User")
$env:SNARK_SERVICE_REGISTRY=$Registry

if (-not (Has "wsl.exe")) {
  Say "WSL is not available. H3 local restore needs WSL2 + Ubuntu-24.04; other components are restored."
}

Run-Deploy doctor
Say "Bootstrap finished. Registry: $Registry"
