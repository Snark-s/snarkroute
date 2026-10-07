param(
  [string]$Bundle = "",
  [string]$ProcessRoot = "",
  [string]$AppsRoot = ""
)
$ErrorActionPreference = "Stop"
function Say([string]$Text) { Write-Host "[SnarkDeploy] $Text" }
function Has([string]$Command) { return [bool](Get-Command $Command -ErrorAction SilentlyContinue) }
function Install-Winget([string]$Id) {
  Say "Installing $Id"
  winget install --id $Id -e --accept-source-agreements --accept-package-agreements
}
if (-not (Has "winget")) { throw "winget is required. Install Microsoft App Installer first." }
if (-not (Has "git")) { Install-Winget "Git.Git" }
if (-not (Has "python") -and -not (Has "py")) { Install-Winget "Python.Python.3.11" }
if (-not (Has "node")) { Install-Winget "OpenJS.NodeJS.LTS" }
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
if (-not (Has "corepack")) {
  Say "Installing Corepack"
  npm install -g corepack
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")
}
if ([string]::IsNullOrWhiteSpace($ProcessRoot)) {
  if (Test-Path "Y:\") { $ProcessRoot="Y:\Процесс" } else { $ProcessRoot="C:\Snark\Process" }
}
if ([string]::IsNullOrWhiteSpace($AppsRoot)) {
  if (Test-Path "Y:\") { $AppsRoot="Y:\Приложения" } else { $AppsRoot="C:\Snark\Apps" }
}
[Environment]::SetEnvironmentVariable("SNARK_PROCESS_ROOT",$ProcessRoot,"User")
[Environment]::SetEnvironmentVariable("SNARK_APPS_ROOT",$AppsRoot,"User")
$env:SNARK_PROCESS_ROOT=$ProcessRoot
$env:SNARK_APPS_ROOT=$AppsRoot
$Repo=Join-Path $ProcessRoot "SnarkRoute"
New-Item -ItemType Directory -Force -Path $ProcessRoot | Out-Null
New-Item -ItemType Directory -Force -Path $AppsRoot | Out-Null
if (-not (Test-Path (Join-Path $Repo ".git"))) {
  Say "Cloning SnarkRoute"
  git clone https://github.com/Snark-s/snarkroute.git $Repo
}
$Deploy=Join-Path $Repo "deploy\snarkdeploy\snarkdeploy.py"
function Run-Deploy([Parameter(ValueFromRemainingArguments=$true)][string[]]$DeployArgs) {
  if (Has "python") { & python $Deploy @DeployArgs } else { & py -3 $Deploy @DeployArgs }
  if ($LASTEXITCODE -ne 0) { throw "SnarkDeploy failed: $($DeployArgs -join ' ')" }
}
if (-not [string]::IsNullOrWhiteSpace($Bundle)) { Run-Deploy restore $Bundle }
Run-Deploy install
$Registry=Join-Path $env:LOCALAPPDATA "SnarkRoute\service-registry.json"
[Environment]::SetEnvironmentVariable("SNARK_SERVICE_REGISTRY",$Registry,"User")
$env:SNARK_SERVICE_REGISTRY=$Registry
Run-Deploy doctor
Say "Bootstrap finished. Registry: $Registry"
