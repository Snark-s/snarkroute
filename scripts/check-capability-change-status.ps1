$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
git status --short --untracked-files=all -- AGENTS.md docs/agent-capabilities-and-delegation.md scripts/discover-coding-agents.ps1 scripts/check-coding-agent-discovery.ps1 apps/server/src/mcp/coding-agent-tools.ts apps/server/src/mcp/server.ts
Write-Output '--- ignored? ---'
git check-ignore -v docs/agent-capabilities-and-delegation.md scripts/discover-coding-agents.ps1 apps/server/src/mcp/coding-agent-tools.ts 2>$null
