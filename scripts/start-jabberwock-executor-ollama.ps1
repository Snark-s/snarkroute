param(
  [Parameter(Mandatory = $true)][string]$ModelsPath,
  [ValidateRange(1024,32768)][int]$ContextLength = 8192,
  [ValidateRange(0,8589934592)][long]$GpuReserveBytes = 2147483648
)
$ErrorActionPreference = 'Stop'
$taskModels = (Resolve-Path -LiteralPath $ModelsPath).Path
if (!(Test-Path -LiteralPath $taskModels -PathType Container)) { throw 'Existing model directory required; no download.' }
if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) { throw 'Ollama endpoint already running; configure or stop that owned process explicitly first.' }
$taskExe = (Get-Command ollama.exe).Source
$taskOutput = Join-Path $PSScriptRoot '../apps/server/data/jabberwock'
$taskSettings = @{
  OLLAMA_MODELS = $taskModels
  OLLAMA_HOST = '127.0.0.1:11434'
  OLLAMA_NO_CLOUD = '1'
  OLLAMA_CONTEXT_LENGTH = "$ContextLength"
  OLLAMA_GPU_OVERHEAD = "$GpuReserveBytes"
  OLLAMA_MAX_LOADED_MODELS = '1'
  OLLAMA_NUM_PARALLEL = '1'
}
$taskPrevious = @{}
try {
  foreach ($taskKey in $taskSettings.Keys) {
    $taskPrevious[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process')
    [Environment]::SetEnvironmentVariable($taskKey, $taskSettings[$taskKey], 'Process')
  }
  $taskProcess = Start-Process -FilePath $taskExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskOutput 'executor-ollama.stdout.log') -RedirectStandardError (Join-Path $taskOutput 'executor-ollama.stderr.log')
  [pscustomobject]@{ pid = $taskProcess.Id; endpoint = 'http://127.0.0.1:11434/v1'; modelsPath = $taskModels; contextLength = $ContextLength; gpuReserveBytes = $GpuReserveBytes; cloudDisabled = $true } | ConvertTo-Json
} finally {
  foreach ($taskKey in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskKey, $taskPrevious[$taskKey], 'Process') }
}
