# Owner-local repair for Windows PowerShell 5.1 UTF-8 decoding.
# Run this file on the owner's Windows machine, never as a bridge job.
$ErrorActionPreference = "Stop"
$src = Join-Path $PSScriptRoot "owner-flux3-workflow.ps1"
$dest = "I:\SnarkBridge\owner-workflows\flux3-owner-workflow.ps1"
if (-not (Test-Path -LiteralPath $src)) { throw "Missing source: $src" }
if (-not (Test-Path -LiteralPath $dest)) { throw "Missing approved owner workflow: $dest" }
$old = "$dest.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $dest -Destination $old -ErrorAction Stop
$strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
$text = [System.IO.File]::ReadAllText($src, $strictUtf8)
$bom = [System.Text.UTF8Encoding]::new($true)
[System.IO.File]::WriteAllText($dest, $text, $bom)
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($dest, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
    Copy-Item -LiteralPath $old -Destination $dest -Force
    throw "PowerShell syntax failed; original restored: $($parseErrors[0].Message)"
}
Write-Output "FLUX3_OWNER_WORKFLOW_UTF8_READY"
Write-Output "Backup: $old"
