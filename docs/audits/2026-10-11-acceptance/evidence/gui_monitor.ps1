param([string]$Out, [string]$Exe, [string]$Registry, [string]$SessionScript)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public static System.Collections.Generic.List<IntPtr> ForPid(uint pid) {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public struct RECT { public int L, T, R, B; }
}
'@
function ShotAll([int]$procId, [string]$prefix) {
  $i = 0; $meta = @()
  foreach ($h in [W]::ForPid([uint32]$procId)) {
    $sb = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText($h, $sb, 256)
    $m = Shot $h ("$prefix-$i.png"); $m.title = $sb.ToString(); $meta += $m
    if ($m.title -eq 'Agent Bubble Status') {
      # Composited screen pixels of the small bubble rect only (includes the separate Jabberwock overlay).
      $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
      $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $g.Dispose()
      $bmp.Save("$prefix-bubble-screen.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
      $m.rect = "$($r.L),$($r.T),$($r.R),$($r.B)"
    }
    $i++
  }
  return $meta
}
function Shot([IntPtr]$h, [string]$path) {
  $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [void][W]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return @{ w = $w; h = $hh; dpi = [W]::GetDpiForWindow($h) }
}
New-Item -ItemType Directory -Force $Out | Out-Null
$dnsBefore = @(Get-DnsClientCache -EA SilentlyContinue | ? Entry -match 'mixar|sentry|posthog|amplitude|segment|mixpanel' | % Entry)
$env:SNARKROUTE_PORT_REGISTRY = $Registry
$env:SNARK_MIXAR_LOCAL = '1'
$env:ACCEPTANCE_GUI_OUT = Join-Path $Out 'session.json'
$runtime = Split-Path -Parent $Exe
$launch = @('--python', "`"$SessionScript`"")
if ($env:ACCEPTANCE_BLEND) { $launch = @("`"$env:ACCEPTANCE_BLEND`"") + $launch }
$p = Start-Process -FilePath $Exe -ArgumentList $launch -WorkingDirectory $runtime -PassThru
$conns = @{}; $shots = @{}
$t0 = Get-Date
while (-not $p.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt 110) {
  $ids = @($p.Id) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | % ProcessId)
  foreach ($c in @(Get-NetTCPConnection -OwningProcess $ids -EA SilentlyContinue)) {
    $key = "$($c.LocalAddress):$($c.LocalPort)->$($c.RemoteAddress):$($c.RemotePort) $($c.State)"
    if (-not $conns.ContainsKey($key)) { $conns[$key] = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) }
  }
  $el = ((Get-Date) - $t0).TotalSeconds
  $p.Refresh()
  if ($p.MainWindowHandle -ne 0) {
    if ($el -ge 30 -and -not $shots.s1) { $shots.s1 = ShotAll $p.Id (Join-Path $Out 'scale1') }
    if ($el -ge 55 -and -not $shots.s2) { $shots.s2 = ShotAll $p.Id (Join-Path $Out 'scale2') }
  }
  Start-Sleep -Milliseconds 250
}
$exited = $p.HasExited
$dnsAfter = @(Get-DnsClientCache -EA SilentlyContinue | ? Entry -match 'mixar|sentry|posthog|amplitude|segment|mixpanel' | % Entry)
$external = @($conns.Keys | ? { $_ -notmatch '->(127\.0\.0\.1|::1|0\.0\.0\.0|::):' })
[ordered]@{ pid = $p.Id; exitedBySelf = $exited; exitCode = $(if ($exited) { $p.ExitCode } else { $null });
  connections = $conns; externalConnections = $external; dnsNewSuspicious = @($dnsAfter | ? { $dnsBefore -notcontains $_ });
  shots = $shots } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $Out 'monitor.json')
if (-not $exited) { 'STILL RUNNING pid ' + $p.Id }
