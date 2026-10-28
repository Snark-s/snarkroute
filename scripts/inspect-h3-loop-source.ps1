$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function ShowRange($file,$a,$b) {
  $lines = [System.IO.File]::ReadAllLines((Join-Path $root $file))
  Write-Output ("=== "+$file+" "+$a+"-"+$b+" ===")
  for ($i=$a-1; $i -lt [Math]::Min($b,$lines.Length); $i++) {
    Write-Output ("{0,4} {1}" -f ($i+1),$lines[$i])
  }
}
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 335 385
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 510 620
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 660 725
ShowRange 'workers/minimax-h3/app/backends/h3_cyclic.py' 15 186
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 125 225
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 380 440
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 960 1008
ShowRange 'workers/minimax-h3/app/backends/h3_cyclic.py' 182 209
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 40 110
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 440 514
ShowRange 'workers/minimax-h3/app/backends/matlow_runtime.py' 292 335
