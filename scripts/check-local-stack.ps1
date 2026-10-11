param([switch]$Blender, [switch]$LiveUnavailable)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $env:SNARKROUTE_PORT_REGISTRY = Join-Path $root 'service-endpoints.json'
    $env:PYTHONPATH = Join-Path $root 'tests/stack'
    $env:TEMP = Join-Path $root '.tmp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    node --test scripts/local-service-registry.test.mjs scripts/persona-bridge.test.mjs scripts/launcher-control.test.mjs scripts/project-publisher-control.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Node contract tests failed' }
    python -X utf8 -m unittest discover -s tests/stack -p 'test_*.py'
    if ($LASTEXITCODE -ne 0) { throw 'Cross-component Python tests failed' }
    & (Join-Path $root 'tests/stack/tunnel_freshness_probe.ps1')
    & (Join-Path $root 'tests/stack/scheduled_startup_probe.ps1')
    python -X utf8 -m unittest discover -s deploy/snarkdeploy -p test_snarkdeploy.py
    if ($LASTEXITCODE -ne 0) { throw 'Recovery tests failed' }
    if ($LiveUnavailable) {
        node tests/stack/live_unavailable_route.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Live unavailable-route test failed' }
    }
    if ($Blender) {
        $registry = Get-Content -LiteralPath $env:SNARKROUTE_PORT_REGISTRY -Raw -Encoding UTF8 | ConvertFrom-Json
        $runtime = $registry.paths.mixar_runtime
        if (-not [IO.Path]::IsPathRooted($runtime)) { $runtime = Join-Path $root $runtime }
        $executable = Join-Path ([IO.Path]::GetFullPath($runtime)) 'mixar.exe'
        $env:SNARK_MIXAR_LOCAL = '1'
        $reportDirectory = Join-Path $root ('.tmp/stack-check-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $reportDirectory | Out-Null
        foreach ($probe in @('portable_mixar_probe', 'blender_rpc_integration', 'headless_contract_probe', 'headless_contract_probe')) {
            $env:MIXAR_AUDIT_REPORT = Join-Path $reportDirectory ([Guid]::NewGuid().ToString('N') + '.json')
            & $executable --factory-startup --background --python-exit-code 1 --python (Join-Path $root ('tests/stack/' + $probe + '.py'))
            if ($LASTEXITCODE -ne 0) { throw ('Factory Blender probe failed: ' + $probe) }
        }
    }
} finally { Pop-Location }
