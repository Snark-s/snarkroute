param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("probe","test","weights")]
  [string]$Mode
)
$ErrorActionPreference = 'Stop'
$project = 'Y:\Процесс\SnarkRoute'
$here = Join-Path $project 'integrations\flux3-comfy'
if (-not (Test-Path -LiteralPath $here)) { throw "FLUX.3 integration not found: $here" }

function Find-Comfy {
  $candidates = @($env:COMFYUI_ROOT, 'C:\ComfyUI', 'D:\ComfyUI',
    'Y:\Приложения\ComfyUI', 'Y:\Процесс\ComfyUI',
    'X:\Мастерская\ComfyUI') | Where-Object { $_ }
  foreach ($item in $candidates) {
    if (Test-Path -LiteralPath $item -PathType Container) {
      $models = Join-Path -Path $item -ChildPath 'models'
      if (Test-Path -LiteralPath $models -PathType Container) { return $item }
    }
  }
  return $null
}
function Run-External([string]$Exe, [string[]]$Arguments) {
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe exited $LASTEXITCODE" }
}
switch ($Mode) {
  'probe' {
    Write-Output "SnarkRoute: $project"
    Write-Output "ComfyUI root: $(Find-Comfy)"
    Write-Output "ComfyUI workflow present: $(Test-Path -LiteralPath (Join-Path $here 'workflow.api.json'))"
    foreach ($command in @('git','node','corepack','hf','nvidia-smi')) {
      $found = Get-Command $command -ErrorAction SilentlyContinue
      Write-Output "$command : $($found.Source)"
    }
    try {
      $stats = Invoke-RestMethod -Uri 'http://127.0.0.1:8188/system_stats' -TimeoutSec 4
      Write-Output 'ComfyUI loopback API: online'
    } catch { Write-Output 'ComfyUI loopback API: offline' }
    if (Get-Command git -ErrorAction SilentlyContinue) {
      Push-Location $project
      try { Run-External 'git' @('status','--short') } finally { Pop-Location }
    }
  }
  'test' {
    if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) { throw 'corepack not installed' }
    Push-Location $project
    try {
      Run-External 'corepack' @('pnpm','--filter','@snarkroute/server','test','--','flux3-comfy')
      Run-External 'corepack' @('pnpm','--filter','@snarkroute/server','build')
    } finally { Pop-Location }
  }
  'weights' {
    $comfy = Find-Comfy
    if (-not $comfy) { throw 'ComfyUI models folder not found. Set COMFYUI_ROOT in owner environment and reconfigure this fixed workflow.' }
    if (-not (Get-Command hf -ErrorAction SilentlyContinue)) { throw 'Hugging Face CLI (hf) not installed or not on PATH.' }
    Write-Output "Downloading FLUX.3 INT8 weights into $comfy\models"
    Run-External 'hf' @('download','black-forest-labs/flux-3-image-klein-comfy',
       'diffusion_models/flux3_image_klein_sd_int8_convrot.safetensors',
       'text_encoders/qwen3vl_4b_int8_convrot.safetensors',
       'vae/flux2-vae.safetensors',
       '--local-dir',(Join-Path $comfy 'models'))
  }
}
