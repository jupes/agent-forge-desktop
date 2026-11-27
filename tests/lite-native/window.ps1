param(
  [Parameter(Mandatory)][int]$AppPid,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$Template,
  [Parameter(Mandatory)][string]$Catalog,
  [Parameter(Mandatory)][string]$ProjectName,
  [Parameter(Mandatory)][string]$Screenshot
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Native UI verification requires an isolated GitHub-hosted Windows runner'
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LiteWindow {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
}
'@
[void][LiteWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$scope = [Windows.Automation.TreeScope]::Descendants
$trueCondition = [Windows.Automation.Condition]::TrueCondition
$documentCondition = [Windows.Automation.PropertyCondition]::new(
  [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Document)
$app = Get-Process -Id $AppPid
if ($app.Path -ne $Executable) { throw 'The supplied PID does not own the staged executable' }

function Get-SafeNames($nodes) {
  @($nodes | ForEach-Object { $_.Current.Name } | Where-Object {
    $_ -and $_.Length -le 85 -and $_ -match '^[\w ,.?!()+-]+$'
  } | Select-Object -Unique -First 18) -join ' | '
}

function Find-Named($parent, [string]$name) {
  $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
  $parent.FindFirst($scope, $condition)
}

function Wait-LiteContent([string]$stage, [scriptblock]$test, [int]$seconds) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $detail = 'no native window'
  $window = $null
  $document = $null
  while ($timer.Elapsed.TotalSeconds -lt $seconds) {
    $app.Refresh()
    if ($app.HasExited) { throw "Lite exited while observing $stage with code $($app.ExitCode)" }
    $handle = $app.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero -and $app.MainWindowTitle -ceq 'Agent Forge Lite') {
      [uint32]$windowPid = 0
      [void][LiteWindow]::GetWindowThreadProcessId($handle, [ref]$windowPid)
      if ($windowPid -ne $AppPid) { throw 'The native window changed owners' }
      if ($null -eq $window) { Write-Host "Found native window for PID $AppPid, title Agent Forge Lite after $($timer.ElapsedMilliseconds) ms" }
      try {
        $window = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $document = $window.FindFirst($scope, $documentCondition)
        $detail = 'native window; no WebView document'
        if ($null -ne $document) {
          $nodes = $document.FindAll($scope, $trueCondition)
          $detail = "WebView document; correct title=$($document.Current.Name -ceq 'Agent Forge Lite'); descendants=$($nodes.Count)"
          if ($document.Current.Name -ceq 'Agent Forge Lite') {
            $result = & $test $document $nodes
            if ($null -ne $result) {
              Write-Host "$stage confirmed after $($timer.ElapsedMilliseconds) ms ($detail)"
              return $result
            }
          }
        }
      } catch [Windows.Automation.ElementNotAvailableException] {
        $detail = 'WebView accessibility tree changed during enumeration'
      }
    }
    Start-Sleep -Milliseconds 250
  }
  $names = 'none'
  try {
    if ($null -ne $document) { $names = Get-SafeNames ($document.FindAll($scope, $trueCondition)) }
    elseif ($null -ne $window) { $names = Get-SafeNames ($window.FindAll($scope, $trueCondition)) }
  } catch [Windows.Automation.ElementNotAvailableException] {}
  throw "Timed out observing $stage ($detail); accessible names: $names"
}

function Get-SampleColorCount([Drawing.Bitmap]$bitmap) {
  $colors = [Collections.Generic.HashSet[int]]::new()
  for ($y=10; $y -lt $bitmap.Height; $y+=13) {
    for ($x=10; $x -lt $bitmap.Width; $x+=13) { [void]$colors.Add($bitmap.GetPixel($x,$y).ToArgb()) }
  }
  return $colors.Count
}

function Save-LiteWindow([IntPtr]$handle) {
  $rect = [LiteWindow+Rect]::new()
  if (-not [LiteWindow]::GetClientRect($handle, [ref]$rect) -or $rect.Right -lt 350 -or $rect.Bottom -lt 350) {
    throw 'The native Lite client area was unavailable'
  }
  $bitmap = [Drawing.Bitmap]::new($rect.Right, $rect.Bottom)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc = $graphics.GetHdc()
    try {
      # PW_CLIENTONLY plus PW_RENDERFULLCONTENT captures this window's renderer.
      $printed = [LiteWindow]::PrintWindow($handle, $dc, 3)
    } finally { $graphics.ReleaseHdc($dc) }
    $colorCount = Get-SampleColorCount $bitmap
    if (-not $printed -or $colorCount -lt 12) {
      # GPU-composited children can return a blank bitmap from PrintWindow.
      # Check the visible area belongs to the same window before reading pixels.
      $corner = [LiteWindow+Point]::new()
      if (-not [LiteWindow]::ClientToScreen($handle, [ref]$corner)) { throw 'Native window origin unavailable' }
      foreach ($x in @(1, [int]($bitmap.Width/2), ($bitmap.Width-2))) {
        foreach ($y in @(1, [int]($bitmap.Height/2), ($bitmap.Height-2))) {
          $point = [LiteWindow+Point]::new()
          $point.X = $corner.X + $x
          $point.Y = $corner.Y + $y
          if ([LiteWindow]::GetAncestor([LiteWindow]::WindowFromPoint($point), 2) -ne $handle) {
            throw 'The complete native client area is not available for screen capture'
          }
        }
      }
      $graphics.CopyFromScreen($corner.X, $corner.Y, 0, 0, $bitmap.Size)
      $colorCount = Get-SampleColorCount $bitmap
    }
    if ($colorCount -lt 12) { throw 'Native Lite screenshot contained no rendered interface' }
    $bitmap.Save($Screenshot, [Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Captured native Lite client $($bitmap.Width)x$($bitmap.Height), $colorCount sampled colors"
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$refresh = Wait-LiteContent 'native empty catalog' {
  param($document, $nodes)
  $empty = Find-Named $document 'No projects in this catalog'
  $button = Find-Named $document 'Refresh'
  if ($null -eq $empty -or $null -eq $button -or $button.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or -not $button.Current.IsEnabled) { return }
  foreach ($item in $nodes) {
    if ($item.Current.Name -like '*Tracker data is unavailable.*') { return $button }
  }
} 35

# Publish the unique real catalog only after the empty state has been observed.
[IO.File]::Copy($Template, $Catalog, $false)
$invoke = $refresh.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Host 'Invoked the native WebView Refresh button'
[void](Wait-LiteContent 'saved project graph' {
  param($document, $nodes)
  $graph = Find-Named $document 'Portfolio graph'
  if ($null -eq $graph -or $null -ne (Find-Named $document 'No projects in this catalog')) { return }
  $project = Find-Named $graph $ProjectName
  if ($null -ne $project -and $project.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
      -not $project.Current.IsOffscreen -and $project.Current.BoundingRectangle.Width -gt 0) { return $project }
} 30)
Save-LiteWindow $app.MainWindowHandle
