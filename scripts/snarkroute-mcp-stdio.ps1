# stdio -> Streamable HTTP bridge to SnarkRoute MCP (127.0.0.1:4317/mcp) for clients
# that only launch stdio servers (Claude Desktop, and through it claude.ai chats on
# this computer). Reads SNARKROUTE_MCP_TOKEN from the repo .env so no secret lives
# in client configs. stdout must stay pure JSON-RPC: nothing else is printed here.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$token = $env:SNARKROUTE_MCP_TOKEN
if (-not $token) {
  $match = Select-String -Path (Join-Path $repo '.env') -Pattern '^SNARKROUTE_MCP_TOKEN=(.+)$' | Select-Object -First 1
  if ($match) { $token = $match.Matches[0].Groups[1].Value.Trim().Trim('"') }
}
if (-not $token) { [Console]::Error.WriteLine('SNARKROUTE_MCP_TOKEN is not configured'); exit 1 }
$env:SNARKROUTE_AUTH = "Bearer $token"
& npx.cmd -y mcp-remote@0.15.2 http://127.0.0.1:4317/mcp --header 'Authorization:${SNARKROUTE_AUTH}' --transport http-only --headers-timeout 900 --body-timeout 900
exit $LASTEXITCODE
