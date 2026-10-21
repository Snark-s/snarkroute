# Fast fetch (hf_xet) of the big weights, then download.ps1 for SHA-256 verification,
# the remaining small files and unzip. after-download.ps1 waits on download-done.txt.
$root = $PSScriptRoot
$py = Join-Path (Split-Path $root -Parent) 'flux3-native\.venv\Scripts\python.exe'
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
& $py (Join-Path $root 'fetch-hf.py') *> (Join-Path $root 'results\fetch-hf.out.log')
& (Join-Path $root 'download.ps1')
