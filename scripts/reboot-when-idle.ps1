<#
.SYNOPSIS
Restart Windows at or after a time of day, once no T3 Code thread is working or waiting.

.DESCRIPTION
For an overnight reboot that must not cut off a running agent. Sleeps until
-At (today, or straight on if that has already passed), then polls the live
database READ-ONLY through t3-busy.mjs, the same check restart-t3-when-idle.ps1
uses: runs queued or running and requests waiting on the user, across every
project. Once the count has been zero for -QuietSeconds straight, and is still
zero on one last check, it runs `shutdown /r`.

The restart is forced: `shutdown /t` above 0 implies /f, so other apps close
without a save prompt. -DelaySeconds is the warning Windows shows first;
`shutdown /a` cancels it during that window.

Run it OUTSIDE the app's process tree, or restarting T3 Code before -At kills
the watcher too. From inside T3 Code (an agent's shell), start it through WMI,
which parents it to the WMI service instead:

  Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine =
    'pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <repo>\scripts\reboot-when-idle.ps1' }

Stop a waiting watcher by ending its process (the pid is in the log).
Progress goes to C:\temp\t3runs\reboot-when-idle.log.
#>
[CmdletBinding()]
param(
  # Earliest time of day to restart, in anything Get-Date parses ('22:00', '10pm').
  [string]$At = '22:00',
  # Idle this long, continuously, before restarting. Long enough for a queued
  # follow-up message to start its run.
  [int]$QuietSeconds = 120,
  [int]$PollSeconds = 20,
  # Warning before Windows restarts; `shutdown /a` cancels it meanwhile.
  [int]$DelaySeconds = 60,
  # Give up, without restarting, this long after -At. 0 waits as long as it
  # takes: with agents busy all night, an idle window can be many hours away.
  [double]$MaxHours = 0,
  # Do everything except the restart itself.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Database = Join-Path $env:USERPROFILE '.t3\userdata\statev2.sqlite'
$LogPath = 'C:\temp\t3runs\reboot-when-idle.log'
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

$start = Get-Date $At
$limit = if ($MaxHours -gt 0) { "give up ${MaxHours}h after that" } else { 'no time limit' }
$mode = if ($DryRun) { ', DRY RUN' } else { '' }
Write-Log "reboot when idle, not before $($start.ToString('yyyy-MM-dd HH:mm')) (quiet ${QuietSeconds}s, poll ${PollSeconds}s, $limit, pid $PID$mode)"

# Short sleeps rather than one long one, so a clock change or the machine
# waking from sleep is noticed within a few minutes.
while ((Get-Date) -lt $start) {
  Start-Sleep -Seconds ([math]::Ceiling([math]::Min(300, ($start - (Get-Date)).TotalSeconds)))
}

Write-Log 'start time reached - watching for idle'
$deadline = if ($MaxHours -gt 0) { $start.AddHours($MaxHours) } else { [datetime]::MaxValue }
$idleSince = $null
$lastReport = ''
while ($true) {
  $busy = @()
  # Nothing in one poll may end the watch; a failed poll just counts as busy.
  try { $busy = @(Get-Busy) } catch {
    Write-Log "WARN $($_.Exception.Message)"
    $busy = @([pscustomobject]@{ status = 'unknown'; title = 'database query failed' })
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
    # The quiet period ended a poll ago; make sure nothing started since.
    # An empty result unrolls to $null, so success is tracked separately.
    $rechecked = $false
    try { $recheck = @(Get-Busy); $rechecked = $true } catch { Write-Log "WARN $($_.Exception.Message)" }
    if ($rechecked -and $recheck.Count -eq 0) { break }
    $idleSince = $null
    continue
  }

  if ((Get-Date) -ge $deadline) {
    Write-Log "gave up ${MaxHours}h after the start time without an idle window; nothing restarted"
    exit 1
  }
  Start-Sleep -Seconds $PollSeconds
}

if ($DryRun) {
  Write-Log "idle - DRY RUN, would run: shutdown /r /t $DelaySeconds"
  exit 0
}

Write-Log "idle - restarting Windows in ${DelaySeconds}s (shutdown /a cancels)"
& shutdown.exe /r /t $DelaySeconds /d p:0:0 /c "T3 Code is idle; scheduled restart (reboot-when-idle.ps1). Run 'shutdown /a' to cancel."
if ($LASTEXITCODE -ne 0) {
  Write-Log "shutdown failed with exit code $LASTEXITCODE; nothing restarted"
  exit 1
}
exit 0
