param([switch]$Rotate)
# Explicit owner credential action. Preparing this script does not provision a key.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$directory = Join-Path $env:LOCALAPPDATA 'SnarkDream'
$destination = Join-Path $directory 'mixar_bridge_rpc.dpapi'
$legacy = Join-Path $directory 'mixar_bridge_rpc.token'
if (-not $Rotate -and ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $legacy))) {
    throw 'A credential already exists; use -Rotate only after explicit authorization'
}
[IO.Directory]::CreateDirectory($directory) | Out-Null
$bytes = [byte[]]::new(48)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$random.GetBytes($bytes)
$random.Dispose()
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
$clear = [Text.Encoding]::ASCII.GetBytes($token)
$protected = [Security.Cryptography.ProtectedData]::Protect($clear, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Array]::Clear($bytes, 0, $bytes.Length)
[Array]::Clear($clear, 0, $clear.Length)
$token = $null
$temporary = Join-Path $directory ('.rpc-' + [Guid]::NewGuid().ToString('N') + '.dpapi')
try {
    [IO.File]::WriteAllBytes($temporary, $protected)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $temporary -AclObject $acl
    Move-Item -LiteralPath $temporary -Destination $destination -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Write-Output 'Mixar RPC credential provisioned with CurrentUser DPAPI and owner-only ACL. No credential value is logged.'
# Legacy plaintext, if present, is preserved. The DPAPI file takes precedence.
