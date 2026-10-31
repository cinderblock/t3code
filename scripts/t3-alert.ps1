<#
.SYNOPSIS
Show what went wrong with an unattended relaunch, and how to fix it.

.DESCRIPTION
Started by restart-t3-when-idle.ps1 when a relaunch needs attention. Shows which
stage failed, the end of the log, and a command to copy; "Fix with Claude" runs
that command. The window does not take focus when it opens, so typing elsewhere
never lands in it.

Writes relaunch-failed.txt and fix-prompt.md first, so the details survive a
window that cannot open. If it cannot open, Notepad shows the report instead.

Fixing goes through Claude in this checkout rather than `t3 triage`. Triage
reads upstream's source at a release tag and works toward an upstream issue, and
its CLI may be the very thing that failed to build.

WinForms rather than WPF: a relaunch often fails with the session disconnected,
where WPF draws nothing at all. GDI still draws, so -RenderTo can check this
window without a display and without showing anything.

Needs an STA thread for the clipboard:
  pwsh -NoProfile -STA -File scripts\t3-alert.ps1 -Message '...'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Message,
  # The failed run. Empty when the launcher never got as far as creating one.
  [string]$RunDir,
  [switch]$AppDown,
  # Draw the alert to this PNG. No window opens.
  [string]$RenderTo
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RunsRoot = 'C:\temp\t3runs'
$WatcherLog = Join-Path $RunsRoot 'restart-when-idle.log'
$LauncherLog = if ($RunDir) { Join-Path $RunDir 'launcher.log' }
$ReportPath = Join-Path $RunsRoot 'relaunch-failed.txt'
$PromptPath = Join-Path $(if ($RunDir) { $RunDir } else { $RunsRoot }) 'fix-prompt.md'

function Format-Now {
  $now = Get-Date
  $zone = [TimeZoneInfo]::Local
  $name = if ($zone.IsDaylightSavingTime($now)) { $zone.DaylightName } else { $zone.StandardName }
  $abbreviation = -join ($name -split ' ' | ForEach-Object { $_[0] })
  "$($now.ToString('yyyy-MM-dd h:mm tt')) $abbreviation ($($now.ToUniversalTime().ToString('HH:mm'))Z)"
}

function Get-StageList {
  param([string]$Log)
  # Case matters: "build : stale" is the start of a rebuild, "STALE" skips it.
  $match = { param($pattern) $Log -cmatch "(?m)^\s*$pattern" }
  $stages = @(
    @{ Name = 'Install'; Used = (& $match 'install\s*:'); Done = (& $match 'install\s*: done') }
    @{ Name = 'Build'; Used = $true; Done = (& $match 'build\s*: (done|up to date|STALE)') }
    @{ Name = 'Wait for idle'; Used = $true; Done = (& $match 'idle\?\s*: quiet') }
    @{ Name = 'Stop app'; Used = $true; Done = (& $match '(stop\s*: no T3|stopped)') }
    @{ Name = 'Start backend'; Used = $true; Done = (& $match 'ready\s*:') }
  ) | Where-Object { $_.Used }
  $blocked = -not $Log
  foreach ($stage in $stages) {
    $state = if ($blocked) { 'pending' } elseif ($stage.Done) { 'done' } else { 'failed' }
    if ($state -eq 'failed') { $blocked = $true }
    [pscustomobject]@{ Name = $stage.Name; State = $state }
  }
}

# The launcher's transcript is mostly the header and one line per built asset.
function Get-LogExcerpt {
  param([string]$Log)
  if (-not $Log) { return 'No launcher log: the launcher never started a run.' }
  $lines = $Log -split "`r?`n" |
    ForEach-Object { $_ -replace '\x1b\[[0-9;]*[A-Za-z]', '' } |
    Where-Object { $_ -notmatch '^\s*dist/' -and $_ -notmatch '^\*{10,}$' }
  ($lines | Select-Object -Last 40) -join "`n"
}

$log = if ($LauncherLog) { Get-Content $LauncherLog -Raw -ErrorAction SilentlyContinue }
$stages = @(Get-StageList $log)
$failedStage = ($stages | Where-Object State -EQ 'failed' | Select-Object -First 1).Name
$reason = if ($log -cmatch '(?m)^\s*(?:FAILED|EXITED|SLOW)\s*:\s*(.+)$') { $Matches[1].Trim() }
$commit = if ($log -cmatch '(?m)^\s*commit\s*:\s*(.+)$') { $Matches[1].Trim() }
$excerpt = Get-LogExcerpt $log
$when = Format-Now
$appState = if ($AppDown) { 'T3 Code is down.' } else { 'T3 Code is still running the previous build.' }
$fixCommand = "cd '$RepoRoot'; claude 'Read $PromptPath and follow it.'"

$appRule = if ($AppDown) {
  'The app is down, so nothing is using this checkout: build here, and start it with scripts\start-t3.ps1 once it is fixed.'
} else {
  "The app is running from this checkout's apps\web\dist. Do not stop it, and do not build here: that swaps the web chunks under it. Build in a sibling worktree. Other threads may be active; stage only your own changes."
}

@"
# T3 Code relaunch needs fixing

- What happened: $Message
- Reason: $(if ($reason) { $reason } else { 'not recorded' })
- Failed stage: $(if ($failedStage) { $failedStage } else { 'none recorded' })
- When: $when
- App: $appState
- Commit: $(if ($commit) { $commit } else { 'unknown' })
- Launcher log: $(if ($LauncherLog) { $LauncherLog } else { 'none' })
- Watcher log: $WatcherLog
- Report: $ReportPath

## What to do

1. Read AGENTS.md, then plans/ATTEMPTS.md: it records what has already been tried and refuted.
2. Read the logs above and find the root cause. Say what you found before changing anything.
3. Fix it on master with a test where the failure is logic, and commit. Do not push.
4. Confirm a clean build and boot.
5. Append what you tried and found to plans/ATTEMPTS.md, including what did not work.

## Rules

- $appRule
- Never write to ~/.t3/userdata. Reading and copying from it are fine.
- This is a fork, so upstream's release tags do not match this code. Read this checkout.
- Do not post anything to GitHub.
"@ | Set-Content -Path $PromptPath -Encoding utf8

$stageSummary = ($stages | ForEach-Object { "$($_.Name): $($_.State)" }) -join ', '
$report = @"
T3 Code relaunch needs attention - $when
$Message
$(if ($reason) { "Reason: $reason" })
$appState
Commit: $(if ($commit) { $commit } else { 'unknown' })
Stages: $stageSummary

Fix it:
$fixCommand

Logs:
$(if ($LauncherLog) { $LauncherLog })
$WatcherLog

--- end of launcher log ---
$excerpt
"@ -replace '(\r?\n){3,}', "`n`n"
$report | Set-Content -Path $ReportPath -Encoding utf8

function Get-Color { param([string]$Hex) [Drawing.ColorTranslator]::FromHtml($Hex) }

function Add-Control {
  param($Parent, [string]$Type, [hashtable]$Properties, [int[]]$Bounds)
  $control = New-Object "Windows.Forms.$Type" -Property $Properties
  $control.SetBounds($Bounds[0], $Bounds[1], $Bounds[2], $Bounds[3])
  $Parent.Controls.Add($control)
  $control
}

function Add-Button {
  param($Parent, [string]$Text, [int]$Left, [int]$Width, [string]$Color = '#2A2C33')
  $button = Add-Control $Parent 'Button' @{
    Text = $Text; FlatStyle = 'Flat'; BackColor = Get-Color $Color; ForeColor = Get-Color '#E7E8EC'
    Cursor = [Windows.Forms.Cursors]::Hand; TabStop = $false
  } @($Left, 594, $Width, 32)
  $button.FlatAppearance.BorderSize = 0
  $button
}

function Copy-Text {
  param([string]$Text, $Button)
  try {
    [Windows.Forms.Clipboard]::SetText($Text)
    $Button.Text = 'Copied'
  } catch {
    $Button.Text = 'Copy failed'
  }
}

function Show-Alert {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $formAssembly = [Windows.Forms.Form].Assembly
  $references = @($formAssembly.GetReferencedAssemblies().Name + $formAssembly.GetName().Name + 'System.Runtime')
  Add-Type -ReferencedAssemblies $references -TypeDefinition @'
public class T3AlertForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
}
'@
  [void][Windows.Forms.Application]::SetHighDpiMode('PerMonitorV2')

  $mono = [Drawing.Font]::new('Cascadia Mono', 9)
  if ($mono.Name -ne 'Cascadia Mono') { $mono = [Drawing.Font]::new('Consolas', 9.5) }
  $body = [Drawing.Font]::new('Segoe UI', 9.75)
  $text = Get-Color '#E7E8EC'
  $muted = Get-Color '#8B8E99'
  $field = Get-Color '#101114'

  $form = New-Object T3AlertForm -Property @{
    Text = 'T3 Code relaunch'; StartPosition = 'CenterScreen'; FormBorderStyle = 'FixedSingle'
    MaximizeBox = $false; BackColor = Get-Color '#17181C'; ForeColor = $text; Font = $body
    AutoScaleDimensions = [Drawing.SizeF]::new(96, 96); AutoScaleMode = 'Dpi'
    ClientSize = [Drawing.Size]::new(780, 640)
  }

  $chipText = if ($AppDown) { 'T3 Code is down' } else { 'Previous build still running' }
  $chipWidth = if ($AppDown) { 124 } else { 190 }
  $headline = if ($failedStage) { "Relaunch failed at $failedStage" } else { 'Relaunch needs attention' }
  [void](Add-Control $form 'Label' @{
      Text = $headline; AutoEllipsis = $true; Font = [Drawing.Font]::new('Segoe UI Semibold', 14)
    } @(20, 14, (740 - $chipWidth - 12), 32))
  [void](Add-Control $form 'Label' @{
      Text = $chipText; TextAlign = 'MiddleCenter'; ForeColor = $field
      BackColor = Get-Color $(if ($AppDown) { '#F85149' } else { '#D29922' })
      Font = [Drawing.Font]::new('Segoe UI Semibold', 9)
    } @((760 - $chipWidth), 18, $chipWidth, 24))
  [void](Add-Control $form 'Label' @{
      Text = (@($Message, $reason, $commit) | Where-Object { $_ }) -join ' - '
      AutoEllipsis = $true; ForeColor = Get-Color '#A9ACB6'
    } @(20, 48, 740, 40))

  $strip = Add-Control $form 'Panel' @{} @(20, 96, 740, 62)
  $strip.Add_Paint({
      param($panel, $paint)
      $graphics = $paint.Graphics
      $graphics.SmoothingMode = 'AntiAlias'
      $graphics.TextRenderingHint = 'ClearTypeGridFit'
      $scale = $panel.DeviceDpi / 96
      $radius = 13 * $scale
      $column = $panel.ClientSize.Width / $stages.Count
      $track = [Drawing.Pen]::new((Get-Color '#3A3D46'), 2 * $scale)
      $graphics.DrawLine($track, ($column / 2), $radius, (($stages.Count - 0.5) * $column), $radius)
      $track.Dispose()
      $centered = [Drawing.StringFormat]@{ Alignment = 'Center'; LineAlignment = 'Center' }
      foreach ($index in 0..($stages.Count - 1)) {
        $stage = $stages[$index]
        $x = ($index + 0.5) * $column
        $color = @{ done = '#3FB950'; failed = '#F85149'; pending = '#4A4D57' }[$stage.State]
        $fill = [Drawing.SolidBrush]::new((Get-Color $color))
        $graphics.FillEllipse($fill, ($x - $radius), 0, (2 * $radius), (2 * $radius))
        $fill.Dispose()
        $glyph = @{ done = [string][char]0x2713; failed = [string][char]0x2715; pending = '' }[$stage.State]
        $ink = [Drawing.SolidBrush]::new($field)
        $graphics.DrawString($glyph, $body, $ink, [Drawing.RectangleF]::new(($x - $radius), 0, (2 * $radius), (2 * $radius)), $centered)
        $ink.Dispose()
        $labelInk = [Drawing.SolidBrush]::new($(if ($stage.State -eq 'pending') { $muted } else { $text }))
        $graphics.DrawString($stage.Name, $body, $labelInk, [Drawing.RectangleF]::new(($x - $column / 2), (2 * $radius + 4 * $scale), $column, (24 * $scale)), $centered)
        $labelInk.Dispose()
      }
      $centered.Dispose()
    })

  [void](Add-Control $form 'Label' @{ Text = 'Fix it: paste this in a terminal, or use Fix with Claude'; ForeColor = $muted } @(20, 168, 740, 20))
  [void](Add-Control $form 'TextBox' @{
      Text = $fixCommand; ReadOnly = $true; Multiline = $true; BackColor = $field; ForeColor = Get-Color '#C9CBD3'
      BorderStyle = 'FixedSingle'; Font = $mono
    } @(20, 190, 740, 42))
  [void](Add-Control $form 'Label' @{ Text = 'End of the launcher log'; ForeColor = $muted } @(20, 242, 740, 20))
  $logBox = Add-Control $form 'TextBox' @{
    Text = ($excerpt -replace '\r?\n', "`r`n"); Multiline = $true; ReadOnly = $true; WordWrap = $false
    ScrollBars = 'Both'; BackColor = $field; ForeColor = Get-Color '#C9CBD3'; BorderStyle = 'FixedSingle'; Font = $mono
  } @(20, 264, 740, 316)

  $fix = Add-Button $form 'Fix with Claude' 20 130 '#3B6FE0'
  $copyCommand = Add-Button $form 'Copy command' 158 120
  $copyReport = Add-Button $form 'Copy report' 286 110
  $openRun = Add-Button $form 'Open run folder' 404 130
  $dismiss = Add-Button $form 'Close' 660 100

  # Child controls only draw once the window has been shown, so show it off-screen.
  if ($RenderTo) {
    $form.StartPosition = 'Manual'
    $form.Location = [Drawing.Point]::new(-32000, -32000)
    $form.ShowInTaskbar = $false
    $form.Show()
    [Windows.Forms.Application]::DoEvents()
    $bitmap = [Drawing.Bitmap]::new($form.Width, $form.Height)
    $form.DrawToBitmap($bitmap, [Drawing.Rectangle]::new(0, 0, $form.Width, $form.Height))
    $bitmap.Save($RenderTo, [Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    $form.Close()
    return
  }

  $fix.Add_Click({
      $claude = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
      if (-not $claude) { $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
      $prompt = "Read $PromptPath and follow it." -replace "'", "''"
      Start-Process -FilePath (Get-Process -Id $PID).Path -WorkingDirectory $RepoRoot -ArgumentList @(
        '-NoExit', '-NoProfile', '-Command', "& '$claude' '$prompt'"
      )
      $this.Text = 'Claude started'
    })
  $copyCommand.Add_Click({ Copy-Text $fixCommand $this })
  $copyReport.Add_Click({ Copy-Text $report $this })
  $openRun.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$(if ($RunDir) { $RunDir } else { $RunsRoot })`"" })
  $dismiss.Add_Click({ $form.Close() })
  $form.Add_Shown({
      $logBox.SelectionStart = $logBox.TextLength
      $logBox.ScrollToCaret()
    })
  [Windows.Forms.Application]::Run($form)
}

try {
  Show-Alert
} catch {
  if ($RenderTo) { throw }
  Add-Content -Path $ReportPath -Value "`nThe alert window could not open: $($_.Exception.Message)" -Encoding utf8
  Start-Process -FilePath 'notepad.exe' -ArgumentList "`"$ReportPath`""
}
