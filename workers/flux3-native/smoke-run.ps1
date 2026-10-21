$ErrorActionPreference = 'Continue'
# PowerShell 5 pipes stdin to native programs as ASCII by default; Cyrillic paths would become '?'.
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = $PSScriptRoot
$res = Join-Path $root 'results'
New-Item -ItemType Directory -Force $res | Out-Null
"STARTED $(Get-Date -Format o)" | Set-Content (Join-Path $res 'smoke-started.txt')
$req = @{ prompt = 'A small red fox sitting on a mossy stone in a misty birch forest, soft morning light, painterly'; width = 512; height = 512; steps = 16; seed = 42; output = (Join-Path $res 'smoke-512.png') } | ConvertTo-Json -Compress
$gpuLog = Join-Path $res 'smoke-gpu.csv'
$sampler = Start-Job -ScriptBlock { param($p) while ($true) { nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader | Add-Content $p; Start-Sleep 2 } } -ArgumentList $gpuLog
$t0 = Get-Date
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
$env:PYTHONIOENCODING = 'utf-8'
$req | & (Join-Path $root '.venv\Scripts\python.exe') (Join-Path $root 'infer.py') *> (Join-Path $res 'smoke-run.log')
$code = $LASTEXITCODE
$sec = [int]((Get-Date) - $t0).TotalSeconds
Stop-Job $sampler; Remove-Job $sampler
"EXIT=$code SECONDS=$sec" | Set-Content (Join-Path $res 'smoke-done.txt')
