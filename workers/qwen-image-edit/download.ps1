# Download stable-diffusion.cpp (official Windows CUDA 12 build) and Qwen-Image-Edit-2511
# weights. Resumable (curl -C -), verified by SHA-256 published by the source
# (GitHub asset digest / Hugging Face X-Linked-Etag). ASCII-only on purpose (PS 5).
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = $PSScriptRoot
$bin = Join-Path $root 'bin'; $models = Join-Path $root 'models'; $res = Join-Path $root 'results'
New-Item -ItemType Directory -Force $bin, $models, $res | Out-Null
$log = Join-Path $res 'download.log'
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content $log }
trap { Log "FAIL $_"; "FAIL $_" | Set-Content (Join-Path $res 'download-done.txt'); exit 1 }

$tag = 'master-982-0518b34'
$gh = Invoke-RestMethod "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/$tag" -Headers @{ 'User-Agent' = 'snarkroute' }
function GhAsset($name) {
  $a = $gh.assets | Where-Object name -eq $name
  if (-not $a) { throw "asset $name not found in $tag" }
  @{ name = $name; url = $a.browser_download_url; dest = (Join-Path $root "downloads\$name"); sha = ($a.digest -replace '^sha256:', ''); size = $a.size }
}
function HfFile($repo, $path) {
  $url = "https://huggingface.co/$repo/resolve/main/$path"
  $head = & curl.exe -sIL $url
  $etag = ($head | Select-String -Pattern '^x-linked-etag:\s*"?([0-9a-f]{64})"?' | Select -Last 1).Matches[0].Groups[1].Value
  $size = ($head | Select-String -Pattern '^x-linked-size:\s*(\d+)' | Select -Last 1).Matches[0].Groups[1].Value
  @{ name = (Split-Path $path -Leaf); url = $url; dest = (Join-Path $models (Split-Path $path -Leaf)); sha = $etag; size = [int64]$size }
}

$items = @(
  (GhAsset "sd-master-0518b34-bin-win-cuda12-x64.zip"),
  (GhAsset "cudart-sd-bin-win-cu12-x64.zip"),
  (HfFile 'Comfy-Org/Qwen-Image_ComfyUI' 'split_files/vae/qwen_image_vae.safetensors'),
  (HfFile 'mradermacher/Qwen2.5-VL-7B-Instruct-GGUF' 'Qwen2.5-VL-7B-Instruct.mmproj-Q8_0.gguf'),
  (HfFile 'mradermacher/Qwen2.5-VL-7B-Instruct-GGUF' 'Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf'),
  (HfFile 'unsloth/Qwen-Image-Edit-2511-GGUF' 'qwen-image-edit-2511-Q4_K_M.gguf')
)
New-Item -ItemType Directory -Force (Join-Path $root 'downloads') | Out-Null
$manifest = @()

foreach ($it in $items) {
  if (-not $it.sha -or $it.sha.Length -ne 64) { Log "FAIL no published sha256 for $($it.name)"; throw "no sha256 for $($it.name)" }
  $ok = (Test-Path $it.dest) -and ((Get-Item $it.dest).Length -eq $it.size)
  if (-not $ok) {
    Log "GET $($it.name) $([math]::Round($it.size/1GB,2)) GB"
    & curl.exe -L -C - --retry 20 --retry-delay 10 --retry-all-errors -s -S -o $it.dest $it.url
    if ($LASTEXITCODE -ne 0) { Log "FAIL curl $LASTEXITCODE $($it.name)"; throw "curl failed for $($it.name)" }
  }
  $hash = (Get-FileHash -Algorithm SHA256 $it.dest).Hash.ToLower()
  if ($hash -ne $it.sha) { Log "FAIL sha256 mismatch $($it.name)"; throw "sha256 mismatch for $($it.name)" }
  Log "OK $($it.name) sha256 verified"
  $manifest += [pscustomobject]@{ name = $it.name; url = $it.url; size = $it.size; sha256 = $it.sha }
}

foreach ($zip in Get-ChildItem (Join-Path $root 'downloads') -Filter *.zip) {
  Expand-Archive -Path $zip.FullName -DestinationPath $bin -Force
  Log "UNZIP $($zip.Name)"
}
$manifest | ConvertTo-Json | Set-Content (Join-Path $root 'model-registry.json') -Encoding UTF8
$cli = Get-ChildItem $bin -Recurse -Filter 'sd-cli.exe' | Select -First 1
$srv = Get-ChildItem $bin -Recurse -Filter 'sd-server.exe' | Select -First 1
Log "BIN cli=$($cli.FullName) server=$($srv.FullName)"
"DONE $(Get-Date -Format o)" | Set-Content (Join-Path $res 'download-done.txt')
