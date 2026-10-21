# One-shot Qwen-Image-Edit-2511 smoke with sd-cli: edits results/fox-src.png, logs time,
# peak VRAM (nvidia-smi) and peak RAM of sd-cli. ASCII-only, relative paths (see README).
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = $PSScriptRoot
Set-Location $root
$res = 'results'
New-Item -ItemType Directory -Force $res | Out-Null
Remove-Item "$res\smoke-done.txt", "$res\smoke-gpu.csv", "$res\smoke-edit.png" -ErrorAction SilentlyContinue
"STARTED $(Get-Date -Format o)" | Set-Content "$res\smoke-started.txt"
$gpuLog = Join-Path $root "$res\smoke-gpu.csv"
$sampler = Start-Job -ScriptBlock { param($p) while ($true) { nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader | Add-Content $p; Start-Sleep 2 } } -ArgumentList $gpuLog
$cliArgs = @(
  '--diffusion-model', 'models\qwen-image-edit-2511-Q4_K_M.gguf',
  '--vae', 'models\qwen_image_vae.safetensors',
  '--llm', 'models\Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf',
  '--llm_vision', 'models\Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf',
  '--cfg-scale', '2.5', '--sampling-method', 'euler', '--flow-shift', '3',
  '--offload-to-cpu', '--flash-attn', 'off,diffusion=on',
  '--model-args', 'qwen_image_zero_cond_t=true',
  '-r', "$res\fox-src.png",
  '-p', 'Make the fox tail bright blue. Keep everything else exactly the same: the fox, the stone, the birch forest, the painterly gouache style and the composition.',
  '-W', '512', '-H', '512', '--steps', '20', '--seed', '42', '-v',
  '-o', "$res\smoke-edit.png"
)
# PS 5 Start-Process joins ArgumentList with spaces and does not quote: quote by hand.
$argLine = ($cliArgs | ForEach-Object { if ($_ -match '\s') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
$t0 = Get-Date
$p = Start-Process -FilePath (Join-Path $root 'bin\sd-cli.exe') -ArgumentList $argLine -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput "$res\smoke-run.log" -RedirectStandardError "$res\smoke-run.err.log"
$null = $p.Handle  # PS 5: without touching Handle early, ExitCode stays empty after exit
$peakRam = 0
while (-not $p.HasExited) { try { $p.Refresh(); if ($p.PeakWorkingSet64 -gt $peakRam) { $peakRam = $p.PeakWorkingSet64 } } catch {}; Start-Sleep 2 }
$sec = [int]((Get-Date) - $t0).TotalSeconds
Stop-Job $sampler; Remove-Job $sampler
"EXIT=$($p.ExitCode) SECONDS=$sec PEAK_RAM_GB=$([math]::Round($peakRam/1GB,1))" | Set-Content "$res\smoke-done.txt"
