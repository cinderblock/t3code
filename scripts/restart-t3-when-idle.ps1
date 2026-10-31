<#
.SYNOPSIS
Wait until no T3 Code thread is working or waiting, then relaunch through start-t3.ps1.

.DESCRIPTION
For an update that needs a restart without cutting off a running agent. Polls
the live database READ-ONLY (never written) for runs that are queued or running
and for requests waiting on the user, across every project. Once the count has
been zero for -QuietSeconds straight, it starts start-t3.ps1 -WaitForIdle,
which installs and builds, checks again that nothing started meanwhile (the
build takes minutes), stops the running app and launches the new build.

Run it OUTSIDE the app's process tree, or stopping the app kills it too. From
inside T3 Code (an agent's shell), start it through WMI, which parents it to
the WMI service instead:

  Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine =
    'pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <repo>\scripts\restart-t3-when-idle.ps1' }

An elevated caller gives an elevated watcher, so the launch needs no UAC click.
Progress goes to C:\temp\t3runs\restart-when-idle.log.

An elevated watcher then stays until the launch has an outcome, because a start
that fails leaves no app to report it. With no app running it launches once
more, and if that fails too it opens the t3-alert.ps1 window. A launcher that
fails with the old app still up (a failed build) opens the same alert without
launching again: nothing was lost, but the update did not land.
#>
[CmdletBinding()]
param(
  # Idle this long, continuously, before restarting. Long enough for a queued
  # follow-up message to start its run.
  [int]$QuietSeconds = 120,
  [int]$PollSeconds = 20,
  # Give up, without restarting, after this long. 0 waits as long as it takes:
  # with agents busy all day, an idle window can be many hours away.
  [double]$MaxHours = 0,
  # Claude-only: lets a test keep its log and run markers away from the real ones.
  [string]$RunsRoot = 'C:\temp\t3runs'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Database = Join-Path $env:USERPROFILE '.t3\userdata\statev2.sqlite'
$LogPath = Join-Path $RunsRoot 'restart-when-idle.log'
$LatestRun = Join-Path $RunsRoot 'latest.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $Message"
  # A log write that fails (the file open in an editor) must not end the watch.
  try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch {}
  Write-Host $line
}

$node = Join-Path $env:USERPROFILE '.vite-plus\bin\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source }

function Get-Busy {
  $json = & $node (Join-Path $PSScriptRoot 't3-busy.mjs') $Database 2>&1
  if ($LASTEXITCODE -ne 0) { throw "database query failed: $json" }
  @($json | ConvertFrom-Json)
}

$limit = if ($MaxHours -gt 0) { "give up after ${MaxHours}h" } else { 'no time limit' }
Write-Log "watching for idle (quiet ${QuietSeconds}s, poll ${PollSeconds}s, $limit, pid $PID)"
$deadline = if ($MaxHours -gt 0) { (Get-Date).AddHours($MaxHours) } else { [datetime]::MaxValue }
$idleSince = $null
$lastReport = ''
while ($true) {
  $busy = @()
  # Nothing in one poll may end the watch; a failed poll just counts as busy.
  try { $busy = Get-Busy } catch {
    Write-Log "WARN $($_.Exception.Message)"
    $idleSince = $null
  }

  if ($busy.Count -gt 0) {
    $idleSince = $null
    $report = ($busy | ForEach-Object { "$($_.status): $($_.title)" } | Sort-Object -Unique) -join '; '
    if ($report -ne $lastReport) { Write-Log "busy ($($busy.Count)) - $report"; $lastReport = $report }
  } elseif ($null -eq $idleSince) {
    $idleSince = Get-Date
    $lastReport = ''
    Write-Log 'idle - waiting out the quiet period'
  } elseif (((Get-Date) - $idleSince).TotalSeconds -ge $QuietSeconds) {
    break
  }

  if ((Get-Date) -ge $deadline) {
    Write-Log "gave up after ${MaxHours}h without an idle window; nothing restarted"
    exit 1
  }
  Start-Sleep -Seconds $PollSeconds
}

function Get-LatestRun {
  if (Test-Path $LatestRun) { (Get-Content $LatestRun -Raw).Trim() }
}

# Same identity as Get-T3Processes in start-t3.ps1.
function Test-T3Running {
  $electronRoot = (Join-Path $RepoRoot 'node_modules') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter "Name = 'electron.exe' OR Name LIKE 'T3 Code%'" |
      Where-Object { $_.Name -like 'T3 Code*' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($electronRoot, [StringComparison]::OrdinalIgnoreCase)) }
  ).Count -gt 0
}

# No -KeepOpen: this console is hidden, so a failure would wait for an Enter
# nobody can press, holding the launch mutex against any later launch.
function Start-Launcher {
  foreach ($attempt in 1..3) {
    try {
      $launcher = Start-Process -PassThru -FilePath $shell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-t3.ps1'), '-WaitForIdle'
      )
      Write-Log "launcher started, pid $($launcher.Id); see $LatestRun for its run"
      return $launcher
    } catch {
      Write-Log "WARN launcher did not start (attempt $attempt): $($_.Exception.Message)"
      Start-Sleep -Seconds 10
    }
  }
}

# ready, slow (it printed its 5-minute warning) or failed. The launcher records
# its run directory in latest.txt and every line it prints in that run's log.
function Wait-LaunchOutcome {
  param($Launcher, [string]$PreviousRun)
  while ($true) {
    # Read before the log, so a last line written just before exiting is seen.
    $exited = $Launcher.HasExited
    $run = Get-LatestRun
    if ($run -and $run -ne $PreviousRun) {
      $log = Get-Content (Join-Path $run 'launcher.log') -Raw -ErrorAction SilentlyContinue
      if ($log -match '(?m)^\s*ready\s+:') { return 'ready' }
      if ($log -match '(?m)^\s*SLOW\s+:') { return 'slow' }
    }
    if ($exited) { return 'failed' }
    Start-Sleep -Seconds $PollSeconds
  }
}

# A separate process, so the watcher can exit while the alert stays open. A run
# no newer than the one before this launch belongs to an earlier launch.
function Show-Failure {
  param([string]$Message, [string]$PreviousRun, [switch]$AppDown)
  $run = Get-LatestRun
  $arguments = @(
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', "`"$(Join-Path $PSScriptRoot 't3-alert.ps1')`"", '-Message', "`"$Message`""
  )
  if ($run -and $run -ne $PreviousRun) { $arguments += @('-RunDir', "`"$run`"") }
  if ($AppDown) { $arguments += '-AppDown' }
  $alert = Start-Process -PassThru -FilePath $shell -ArgumentList $arguments
  Write-Log "ALERT $Message; alert pid $($alert.Id), details in $(Join-Path $RunsRoot 'relaunch-failed.txt')"
}

Write-Log 'idle - starting start-t3.ps1'
$shell = (Get-Process -Id $PID).Path
$elevated = (New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
foreach ($try in 1..2) {
  $previousRun = Get-LatestRun
  $launcher = Start-Launcher
  if (-not $launcher) {
    Write-Log 'gave up: the launcher would not start; nothing restarted'
    exit 1
  }
  if (-not $elevated) {
    # It re-launches itself through UAC and exits, so this process says nothing.
    Write-Log 'not elevated: the launcher asks for elevation, and its outcome is not followed'
    exit 0
  }

  $outcome = Wait-LaunchOutcome $launcher $previousRun
  if ($outcome -eq 'ready') {
    Write-Log "relaunched: backend answered, run $(Get-LatestRun)"
    exit 0
  }
  if ($outcome -eq 'slow') {
    Show-Failure 'The backend has not answered after 5 minutes. The app may still come up.' $previousRun
    exit 1
  }
  Write-Log "launcher failed (exit $($launcher.ExitCode)), run $(Get-LatestRun)"
  if (Test-T3Running) {
    Write-Log 'the running app is still up; not launching again'
    Show-Failure 'The relaunch failed, so the update was not applied.' $previousRun
    exit 1
  }
  if ($try -eq 1) { Write-Log 'no app is running; launching once more' }
}
Show-Failure 'The launcher failed twice, and no T3 Code is running.' $previousRun -AppDown
exit 1
