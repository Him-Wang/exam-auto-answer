<#
  browser.ps1 — control a local Edge/Chrome instance that can be driven over CDP.

    powershell -NoProfile -ExecutionPolicy Bypass -File browser.ps1 -Action launch -Port 9223
    powershell -NoProfile -ExecutionPolicy Bypass -File browser.ps1 -Action list
    powershell -NoProfile -ExecutionPolicy Bypass -File browser.ps1 -Action raise -H 199624
    powershell -NoProfile -ExecutionPolicy Bypass -File browser.ps1 -Action kill  -Port 9223

  -Action launch starts a SEPARATE browser profile with a debugging port. Two details matter:
    * -Detach (default) spawns through WMI so the browser survives the parent process tree being
      killed (a plain Start-Process child dies with the shell that started it in sandboxed agents).
    * --disable-sync and the feature flags keep Edge's sync-confirmation popup from stealing the
      CDP page target.
#>
param(
  [ValidateSet('launch', 'list', 'raise', 'kill')]
  [string]$Action = 'list',
  [int]$Port = 9223,
  [string]$Profile,
  [string]$Url = 'about:blank',
  [int]$H = 0,
  [string]$Exe = '',
  [switch]$Visible
)

$ErrorActionPreference = 'Stop'

function Get-BrowserExe {
  if ($Exe) { return $Exe }
  foreach ($p in @(
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )) { if (Test-Path $p) { return $p } }
  throw 'no Edge/Chrome executable found; pass -Exe <path>'
}

function Test-Cdp {
  param([int]$P)
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -TimeoutSec 3 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

switch ($Action) {
  'launch' {
    if (Test-Cdp $Port) { "already listening on $Port"; break }
    $exe = Get-BrowserExe
    if (-not $Profile) { $Profile = Join-Path $env:TEMP "cdp-profile-$Port" }
    New-Item -ItemType Directory -Force -Path $Profile | Out-Null
    $args = @(
      "--remote-debugging-port=$Port",
      "--user-data-dir=$Profile",
      '--no-first-run', '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=msEdgeOnRampDefault,msImplicitSignin',
      '--remote-allow-origins=*',
      '--new-window', $Url
    )
    $line = '"{0}" {1}' -f $exe, ($args -join ' ')
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line }
    if ($r.ReturnValue -ne 0) { throw "WMI Create failed: $($r.ReturnValue) (needs full-access rights)" }
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 400; if (Test-Cdp $Port) { $ok = $true; break } }
    if (-not $ok) { throw "browser started (pid $($r.ProcessId)) but port $Port never came up" }
    "pid=$($r.ProcessId) port=$Port profile=$Profile"
  }
  'list' {
    Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
public struct RECT { public int L, T, R, B; }
'@
    $fg = [W.U]::GetForegroundWindow()
    $rows = New-Object System.Collections.ArrayList
    $cb = [W.U+EnumWindowsProc]{
      param($h, $l)
      if (-not [W.U]::IsWindowVisible($h)) { return $true }
      $cls = New-Object System.Text.StringBuilder 256
      [void][W.U]::GetClassName($h, $cls, 256)
      if ($cls.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
      $len = [W.U]::GetWindowTextLength($h); if ($len -eq 0) { return $true }
      $sb = New-Object System.Text.StringBuilder ($len + 2)
      [void][W.U]::GetWindowText($h, $sb, $len + 2)
      $r = New-Object W.U+RECT
      [void][W.U]::GetWindowRect($h, [ref]$r)
      [void]$rows.Add([pscustomobject]@{
          h = $h.ToInt64(); pid = 0; isFg = ($h -eq $fg)
          size = "$($r.R - $r.L)x$($r.B - $r.T)"; at = "$($r.L),$($r.T)"; title = $sb.ToString()
        })
      return $true
    }
    [void][W.U]::EnumWindows($cb, [IntPtr]::Zero)
    $rows | Format-Table -AutoSize | Out-String -Width 200
  }
  'raise' {
    if (-not $H) { throw 'pass -H <hWnd> (see -Action list)' }
    Add-Type -Namespace W -Name F -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
'@
    $hWnd = [IntPtr]$H
    # A background process may not steal the foreground; tapping ALT releases that lock.
    [W.F]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [W.F]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [void][W.F]::ShowWindow($hWnd, 9)
    [void][W.F]::BringWindowToTop($hWnd)
    $fgPid = 0
    $fgThread = [W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(), [ref]$fgPid)
    $me = [W.F]::GetCurrentThreadId()
    [void][W.F]::AttachThreadInput($me, $fgThread, $true)
    $ok = [W.F]::SetForegroundWindow($hWnd)
    [void][W.F]::AttachThreadInput($me, $fgThread, $false)
    "raised=$ok fg=$([W.F]::GetForegroundWindow().ToInt64()) target=$H"
  }
  'kill' {
    $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
      Where-Object { $_.CommandLine -like "*--remote-debugging-port=$Port*" }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    "stopped $($procs.Count) process(es) for port $Port"
  }
}
