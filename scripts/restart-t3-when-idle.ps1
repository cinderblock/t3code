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
#>
[CmdletBinding()]
param(
  # Idle this long, continuously, before restarting. Long enough for a queued
  # follow-up message to start its run.
  [int]$QuietSeconds = 120,
  [int]$PollSeconds = 20,
  # Give up, without restarting, after this long.
  [double]$MaxHours = 12
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Database = Join-Path $env:USERPROFILE '.t3\userdata\statev2.sqlite'
$LogPath = 'C:\temp\t3runs\restart-when-idle.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

function Write-Log {
  param([string]$Message)
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $Message"
  Add-Content -Path $LogPath -Value $line -Encoding utf8
  Write-Host $line
}

$node = Join-Path $env:USERPROFILE '.vite-plus\bin\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source }

function Get-Busy {
  $json = & $node (Join-Path $PSScriptRoot 't3-busy.mjs') $Database 2>&1
  if ($LASTEXITCODE -ne 0) { throw "database query failed: $json" }
  @($json | ConvertFrom-Json)
}

Write-Log "watching for idle (quiet ${QuietSeconds}s, poll ${PollSeconds}s, give up after ${MaxHours}h)"
$deadline = (Get-Date).AddHours($MaxHours)
$idleSince = $null
$lastReport = ''
while ($true) {
  $busy = @()
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

Write-Log 'idle - starting start-t3.ps1'
$shell = (Get-Process -Id $PID).Path
Start-Process -FilePath $shell -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-t3.ps1'), '-KeepOpen', '-WaitForIdle'
) | Out-Null
Write-Log 'launcher started; see C:\temp\t3runs\latest.txt for its run'
