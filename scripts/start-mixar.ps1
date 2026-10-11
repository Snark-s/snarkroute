param([switch]$Background)
$ErrorActionPreference = 'Stop'
$registryPath = if ($env:SNARKROUTE_PORT_REGISTRY) { $env:SNARKROUTE_PORT_REGISTRY } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'service-endpoints.json' }
$registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($registry.schemaVersion -ne 1 -or $registry.host -ne '127.0.0.1' -or -not $registry.paths.mixar_runtime) { throw 'Mixar runtime is absent from the canonical registry' }
$runtime = $registry.paths.mixar_runtime
if (-not [IO.Path]::IsPathRooted($runtime)) { $runtime = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($registryPath))) $runtime }
$executable = Join-Path ([IO.Path]::GetFullPath($runtime)) 'mixar.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Portable Mixar runtime missing; restore the application component first' }
$env:SNARKROUTE_PORT_REGISTRY = [IO.Path]::GetFullPath($registryPath)
$env:SNARK_MIXAR_LOCAL = '1'
$arguments = if ($Background) { @('--factory-startup', '--background') } else { @() }
if ($Background) { Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $runtime -WindowStyle Hidden }
else { Start-Process -FilePath $executable -WorkingDirectory $runtime }
