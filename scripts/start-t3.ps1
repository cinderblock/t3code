<#
.SYNOPSIS
Launch this fork's T3 Code desktop build, elevated, with diagnostics enabled.

.DESCRIPTION
Cameron runs `scripts\t3.cmd` with NO arguments, ever. Everything that varies
between debugging sessions lives in the RUN CONFIGURATION block below, which
Claude edits. If a run needs different diagnostics, the fix is to edit this
file and commit it -- never to ask for a flag at the call site.

What a run does:

  1. Re-launches itself elevated (the app is wanted with admin rights).
  2. cd's to the repo root -- an elevated process starts in system32, so this
     is not optional.
  3. Rebuilds if any source file is newer than the build artifacts. The app
     runs bundles (apps/server/dist/bin.mjs, apps/desktop/dist-electron/main.cjs),
     NOT source, so a stale bundle silently runs old code. That has already
     cost one debugging session.
  4. Records start/stop markers so the resulting logs can be sliced to exactly
     this run (see "Run markers" below).
  5. Launches the app, then reports where everything landed.

.NOTES
Run markers: each run gets C:\temp\t3runs\<timestamp>\ containing run.json
(metadata, including the byte offsets of server-child.log at start and end so
the exact slice this run appended can be read back), launcher.log, and any
CPU profiles / netlog. `latest.txt` points at the newest run directory.
#>
[CmdletBinding()]
param(
  # Claude-only escape hatches for testing the launcher itself.
  # Cameron never passes these.
  [switch]$NoElevate,
  [switch]$DryRun,
  [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

# ========================= RUN CONFIGURATION =========================
# Claude edits this block between debugging sessions. Nothing here is a
# command-line flag on purpose.
#
# Current objective: capture the synchronous hot path behind the startup
# freeze (34.9s of the first 61.7s is event-loop blocked). CPU profiling is
# the decisive measurement, so it is ON.
$Config = @{
  # V8 CPU profiles. Flushed ONLY on clean exit -- quitting the app normally
  # is required or the profile is never written.
  CpuProf = $true

  # Chromium netlog. Off: the netlog questions (dead saved environments,
  # the homeassistant 404 loop) are already answered and it is just noise now.
  NetLog = $false

  # Event-loop stall reporting threshold in ms (T3_EVENT_LOOP_LAG_MS).
  # 250 catches everything that matters without flooding; 0 disables.
  LagMs = 250

  # auto = rebuild when sources are newer than bundles | always | never
  Build = 'auto'

  # Keep this many run directories before pruning the oldest.
  KeepRuns = 10
}
# =====================================================================

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- elevate -------------------------------------------------------------
if (-not $NoElevate -and -not (Test-Admin)) {
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-KeepOpen')
  if ($DryRun) { $fwd += '-DryRun' }
  Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -ArgumentList $fwd
  exit 0
}

# --- locate the repo -----------------------------------------------------
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'pnpm-workspace.yaml'))) {
  throw "Not a T3 Code workspace: $RepoRoot (expected pnpm-workspace.yaml)"
}
Set-Location $RepoRoot

# --- run directory + markers ---------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunsRoot = 'C:\temp\t3runs'
$RunDir = Join-Path $RunsRoot $stamp
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
Set-Content -Path (Join-Path $RunsRoot 'latest.txt') -Value $RunDir -Encoding utf8

$serverChildLog = Join-Path $env:USERPROFILE '.t3\userdata\logs\server-child.log'
$startOffset = if (Test-Path $serverChildLog) { (Get-Item $serverChildLog).Length } else { 0 }

try { Start-Transcript -Path (Join-Path $RunDir 'launcher.log') -Force | Out-Null } catch {}

Write-Host ''
Write-Host "===== T3 RUN BEGIN $stamp =====" -ForegroundColor Cyan
Write-Host "  repo    : $RepoRoot"
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
$sha = (& git rev-parse --short HEAD 2>$null)
$dirty = if ((& git status --porcelain 2>$null)) { ' (dirty)' } else { '' }
Write-Host "  commit  : $branch @ $sha$dirty"
Write-Host "  run dir : $RunDir"

$already = @(Get-Process -Name electron -ErrorAction SilentlyContinue)
if ($already.Count -gt 0) {
  Write-Host "  WARNING : $($already.Count) electron process(es) already running." -ForegroundColor Yellow
  Write-Host "            A second instance may contend for the database and port." -ForegroundColor Yellow
}

# --- staleness check -----------------------------------------------------
# Compare the newest source mtime against the OLDEST artifact: if any one
# bundle predates a source edit, that bundle is the stale one that will run.
$artifacts = @(
  'apps\desktop\dist-electron\main.cjs'
  'apps\desktop\dist-electron\preload.cjs'
  'apps\server\dist\bin.mjs'
  'apps\web\dist\index.html'
) | ForEach-Object { Join-Path $RepoRoot $_ }

$missing = @($artifacts | Where-Object { -not (Test-Path $_) })
$needsBuild = $false
$reason = ''

if ($Config.Build -eq 'always') {
  $needsBuild = $true; $reason = 'Build=always'
} elseif ($missing.Count -gt 0) {
  $needsBuild = $true; $reason = "missing $(($missing | Split-Path -Leaf) -join ', ')"
} else {
  $oldestArtifact = ($artifacts | ForEach-Object { (Get-Item $_).LastWriteTime } |
    Sort-Object | Select-Object -First 1)
  $srcRoots = @('apps\server\src', 'apps\desktop\src', 'apps\desktop\scripts',
    'apps\web\src', 'packages') | ForEach-Object { Join-Path $RepoRoot $_ } |
    Where-Object { Test-Path $_ }
  $newestSrc = Get-ChildItem -Path $srcRoots -Recurse -File -Include *.ts, *.tsx, *.mjs, *.css 2>$null |
    Where-Object { $_.FullName -notmatch '\\(node_modules|dist|dist-electron)\\' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newestSrc -and $newestSrc.LastWriteTime -gt $oldestArtifact) {
    $needsBuild = $true
    $reason = "$($newestSrc.Name) is newer than the bundles"
  }
}

$didBuild = $false
if ($needsBuild -and $Config.Build -eq 'never') {
  Write-Host "  build   : STALE ($reason) - running anyway (Build=never)" -ForegroundColor Yellow
} elseif ($needsBuild) {
  Write-Host "  build   : stale ($reason) - rebuilding..." -ForegroundColor Yellow
  & pnpm build:desktop
  if ($LASTEXITCODE -ne 0) { throw "build:desktop failed ($LASTEXITCODE)" }
  $didBuild = $true
  Write-Host "  build   : done" -ForegroundColor Green
} else {
  Write-Host "  build   : up to date" -ForegroundColor Green
}

# --- diagnostics ---------------------------------------------------------
$electronArgs = @('--trace-warnings')

if ($Config.LagMs -gt 0) {
  $env:T3_EVENT_LOOP_LAG_MS = "$($Config.LagMs)"
  Remove-Item Env:\T3_EVENT_LOOP_LAG_OFF -ErrorAction SilentlyContinue
  Write-Host "  lag     : reporting stalls >= $($Config.LagMs)ms"
} else {
  $env:T3_EVENT_LOOP_LAG_OFF = '1'
  Write-Host "  lag     : monitor disabled"
}

$profDir = Join-Path $RunDir 'cpuprof'
if ($Config.CpuProf) {
  New-Item -ItemType Directory -Force -Path $profDir | Out-Null
  # Applies to the backend child, which inherits a copy of this env
  # (DesktopBackendConfiguration.ts). 200us interval keeps a ~60s startup
  # profile manageable.
  $env:NODE_OPTIONS = "--cpu-prof --cpu-prof-dir=$profDir --cpu-prof-interval=200"
  Write-Host "  cpuprof : on -> $profDir" -ForegroundColor Yellow
  Write-Host "            QUIT THE APP NORMALLY or no profile is written." -ForegroundColor Yellow
} else {
  Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
}

$netLogPath = Join-Path $RunDir 'netlog.json'
if ($Config.NetLog) {
  $electronArgs += "--log-net-log=$netLogPath"
  Write-Host "  netlog  : $netLogPath"
}

Write-Host "  args    : $($electronArgs -join ' ')"
Write-Host ''

if ($DryRun) {
  Write-Host 'DRY RUN - would execute:' -ForegroundColor Cyan
  Write-Host "  pnpm start:desktop -- $($electronArgs -join ' ')"
  Write-Host "  NODE_OPTIONS=$($env:NODE_OPTIONS)"
  try { Stop-Transcript | Out-Null } catch {}
  exit 0
}

# --- run -----------------------------------------------------------------
Write-Host 'App starting. Quit it normally when done.' -ForegroundColor Green
Write-Host ''
$started = Get-Date
& pnpm start:desktop -- @electronArgs
$code = $LASTEXITCODE
$ended = Get-Date
$endOffset = if (Test-Path $serverChildLog) { (Get-Item $serverChildLog).Length } else { 0 }

# --- markers + summary ---------------------------------------------------
$profiles = @()
if ($Config.CpuProf) {
  $profiles = @(Get-ChildItem -Path $profDir -Filter *.cpuprofile -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending)
}

[ordered]@{
  stamp             = $stamp
  startedUtc        = $started.ToUniversalTime().ToString('o')
  endedUtc          = $ended.ToUniversalTime().ToString('o')
  durationSeconds   = [int]($ended - $started).TotalSeconds
  exitCode          = $code
  branch            = $branch
  commit            = $sha
  dirty             = [bool]$dirty
  rebuilt           = $didBuild
  buildReason       = $reason
  config            = $Config
  serverChildLog    = $serverChildLog
  # Byte range this run appended -- lets the exact slice be read back without
  # guessing timestamps, and survives log rotation ambiguity.
  logStartOffset    = $startOffset
  logEndOffset      = $endOffset
  logBytesAppended  = [Math]::Max(0, $endOffset - $startOffset)
  cpuProfileCount   = $profiles.Count
  largestCpuProfile = if ($profiles.Count -gt 0) { $profiles[0].FullName } else { $null }
} | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $RunDir 'run.json') -Encoding utf8

Write-Host ''
Write-Host "===== T3 RUN END $stamp =====" -ForegroundColor Cyan
Write-Host "  exit    : $code after $([int]($ended - $started).TotalSeconds)s"
Write-Host "  run dir : $RunDir"
Write-Host "  log     : $([Math]::Max(0, $endOffset - $startOffset)) bytes appended to server-child.log"
if ($Config.CpuProf) {
  if ($profiles.Count -gt 0) {
    Write-Host "  cpuprof : $($profiles.Count) profile(s), largest $($profiles[0].Name) ($([int]($profiles[0].Length / 1MB))MB)" -ForegroundColor Green
  } else {
    Write-Host '  cpuprof : NONE WRITTEN - the app was killed rather than quit' -ForegroundColor Red
  }
}
if ($Config.NetLog -and (Test-Path $netLogPath)) { Write-Host "  netlog  : $netLogPath" }
Write-Host ''
Write-Host 'Tell Claude the run is done; everything needed is in the run dir.' -ForegroundColor Cyan

# --- prune old runs ------------------------------------------------------
Get-ChildItem -Path $RunsRoot -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -Skip $Config.KeepRuns |
  ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

try { Stop-Transcript | Out-Null } catch {}
if ($KeepOpen) { Write-Host ''; Read-Host 'press Enter to close' | Out-Null }
exit $code
