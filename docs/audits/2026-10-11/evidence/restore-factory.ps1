param([Parameter(Mandatory)][string]$Target)
$ErrorActionPreference = 'Stop'
$auditTarget = [IO.Path]::GetFullPath($Target)
$auditProofPath = Join-Path $auditTarget 'restore-result.json'
$auditProof = Get-Content -LiteralPath $auditProofPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
if ([IO.Path]::GetFullPath($auditProof.target) -ne $auditTarget) { throw 'Restore proof target mismatch' }
if ($auditProof.credentialsTransferred -ne $false) { throw 'Unexpected credential transfer' }
$auditRoot = Join-Path $auditTarget 'Process/SnarkRoute'
$env:SNARKROUTE_PORT_REGISTRY = Join-Path $auditRoot 'service-endpoints.json'
$env:APPDATA = Join-Path $auditTarget 'Profile'
$env:LOCALAPPDATA = Join-Path $auditTarget 'LocalAppData'
$env:SNARK_MIXAR_LOCAL = '1'
$env:TEMP = Join-Path $auditTarget 'factory-probes'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP | Out-Null
$auditRegistry = Get-Content -LiteralPath $env:SNARKROUTE_PORT_REGISTRY -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
$auditExecutable = Join-Path $auditRegistry.paths.mixar_runtime 'mixar.exe'
if (-not [IO.Path]::GetFullPath($auditExecutable).StartsWith($auditTarget + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime outside restore target' }
$auditResults = @()
foreach ($auditProbe in @('portable_mixar_probe','blender_rpc_integration','headless_contract_probe')) {
    $auditScript = Join-Path $auditRoot ('tests/stack/' + $auditProbe + '.py')
    $auditLog = Join-Path $env:TEMP ($auditProbe + '.log')
    $env:MIXAR_AUDIT_REPORT = Join-Path $env:TEMP ($auditProbe + '.json')
    & $auditExecutable --factory-startup --background --python-exit-code 1 --python $auditScript *> $auditLog
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $auditLog -Tail 30; throw ('Restored probe failed: ' + $auditProbe) }
    $auditResults += @{ probe=$auditProbe; passed=$true; log=$auditLog }
}
$auditProof.factoryLaunch = 'passed: restored portable executable, policy, RPC G/H, scene verification E/F and theme'
$auditProof.factoryProbes = $auditResults
$auditProof.restoredExecutableSha256 = (Get-FileHash -LiteralPath $auditExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($auditProofPath, ($auditProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
$auditProof | ConvertTo-Json -Depth 8
