param([switch]$Install)
$ErrorActionPreference = "Stop"
$worker = $PSScriptRoot
$venv = Join-Path $worker ".venv"
$py = Join-Path $venv "Scripts\python.exe"

if (-not $Install) {
    Write-Output "Dry-run: pass -Install to create a separate virtual environment."
    Write-Output "Installation target: $venv"
    Write-Output "No ComfyUI is needed or installed."
    exit 0
}

if (-not (Test-Path -LiteralPath $py)) {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        & py -3.12 --version
        if ($LASTEXITCODE -eq 0) {
            & py -3.12 -m venv $venv
        } else {
            throw "Python 3.12 required or use Python 3.12 explicitly to create $venv"
        }
    } else {
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) { throw "Python 3.12 not found." }
        & python -m venv $venv
    }
    if ($LASTEXITCODE -ne 0) { throw "Failed to create private Python environment." }
}
& $py -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip update failed." }
& $py -m pip install --upgrade torch torchvision --index-url https://download.pytorch.org/whl/cu128
if ($LASTEXITCODE -ne 0) { throw "CUDA-enabled torch installation failed." }
& $py -m pip install --upgrade diffusers transformers accelerate huggingface_hub pillow safetensors sentencepiece protobuf
if ($LASTEXITCODE -ne 0) { throw "Diffusers installation failed." }
& $py (Join-Path $worker "infer.py") --check
if ($LASTEXITCODE -ne 0) { throw "Native FLUX.3 worker check failed." }
Write-Output "FLUX3_NATIVE_DEPENDENCIES_READY. The gated model download and GPU render have NOT been tested."
