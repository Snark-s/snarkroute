# Read-only discovery for reusable coding-agent executors in SnarkRoute.
# No model calls, no credential disclosure, no quota consumption.
$ErrorActionPreference = 'Continue'
$agents = @(
  @{ id='codex'; command='codex'; purpose='coding'; launch='codex exec' },
  @{ id='claude-code'; command='claude'; purpose='coding'; launch='claude -p' }
)
$results = foreach ($agent in $agents) {
  $cmd = Get-Command $agent.command -ErrorAction SilentlyContinue
  if (-not $cmd) {
    [pscustomobject]@{ id=$agent.id; installed=$false; authenticated=$false; version=$null; quota='unknown'; callable=$false; launch=$agent.launch }
    continue
  }
  $version = ''
  try { $version = ((& $cmd.Source --version 2>$null | Select-Object -First 1) -as [string]).Trim() } catch { $version = '' }
  $authenticated = $false
  try {
    if ($agent.id -eq 'codex') {
      $login = (& $cmd.Source login status 2>&1 | Out-String)
      $authenticated = ($login -match 'Logged in')
    } else {
      $raw = (& $cmd.Source auth status 2>$null | Out-String)
      $state = $raw | ConvertFrom-Json -ErrorAction Stop
      $authenticated = ($state.loggedIn -eq $true)
    }
  } catch {
    $authenticated = $false
  }
  [pscustomobject]@{
    id=$agent.id
    installed=$true
    authenticated=$authenticated
    version=$version
    quota='unknown'
    callable=[bool]$authenticated
    launch=$agent.launch
  }
}
[pscustomobject]@{
  schema_version=1
  checked_at=(Get-Date).ToString('o')
  note='CLI authentication is not quota availability; consult actual runtime errors and cooldowns.'
  executors=@($results)
} | ConvertTo-Json -Depth 5
