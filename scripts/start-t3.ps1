<#
.SYNOPSIS
Launch this fork's T3 Code desktop build, elevated, with diagnostics enabled.

.DESCRIPTION
Replaces the hand-typed
    pnpm start:desktop -- --log-net-log=C:\temp\netlog.json --trace-warnings
so a run is reproducible instead of guess-and-check. It:

  1. Re-launches itself elevated (the app is wanted with admin rights).
  2. cd's to the repo root regardless of where it was invoked from — an
     elevated process starts in system32, so this is not optional.
  3. Rebuilds if any source file is newer than the build artifacts. The
     desktop app runs bundles (apps/server/dist/bin.mjs,
     apps/desktop/dist-electron/main.cjs), NOT source, so a stale bundle
     silently runs old code. That has already cost one debugging session.
  4. Turns on the diagnostics currently being used, and prints where the
     resulting artifacts landed.

.PARAMETER CpuProf
Write V8 CPU profiles to -ProfDir. Profiles are only flushed when the
process exits, so quit the app normally or you get nothing.

.PARAMETER NetLog
Capture a Chromium netlog to -NetLogPath.

.PARAMETER LagMs
Event-loop stall reporting threshold (T3_EVENT_LOOP_LAG_MS). Default 250.
Lower it to see finer stalls; 0 disables the monitor.

.PARAMETER ForceBuild / -NoBuild
Override the staleness check in either direction.

.EXAMPLE
  start-t3.ps1
.EXAMPLE
  start-t3.ps1 -CpuProf
.EXAMPLE
  start-t3.ps1 -NetLog -LagMs 100
#>
[CmdletBinding()]
param(
  [switch]$CpuProf,
  [switch]$NetLog,
  [switch]$ForceBuild,
  [switch]$NoBuild,
  [int]$LagMs = 250,
  [string]$ProfDir = 'C:\temp\t3prof',
  [string]$NetLogPath = 'C:\temp\netlog.json',
  [string]$RepoRoot,
  [switch]$NoElevate,
  [switch]$KeepOpen,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- elevate -------------------------------------------------------------
if (-not $NoElevate -and -not (Test-Admin)) {
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) {
      if ($kv.Value.IsPresent) { $fwd += "-$($kv.Key)" }
    } else {
      $fwd += @("-$($kv.Key)", [string]$kv.Value)
    }
  }
  # -KeepOpen so a failure in the elevated window is readable instead of
  # vanishing the instant the process exits.
  if (-not $KeepOpen) { $fwd += '-KeepOpen' }
  Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -ArgumentList $fwd
  exit 0
}

# --- locate the repo -----------------------------------------------------
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $RepoRoot 'pnpm-workspace.yaml'))) {
  throw "Not a T3 Code workspace: $RepoRoot (expected pnpm-workspace.yaml)"
}
Set-Location $RepoRoot

Write-Host "T3 Code launcher" -ForegroundColor Cyan
Write-Host "  repo   : $RepoRoot"
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
$sha = (& git rev-parse --short HEAD 2>$null)
$dirty = if ((& git status --porcelain 2>$null)) { ' (dirty)' } else { '' }
Write-Host "  commit : $branch @ $sha$dirty"

# --- staleness check -----------------------------------------------------
# Compare newest source mtime against the OLDEST artifact: if any one bundle
# predates a source edit, that bundle is the stale one that will run.
$artifacts = @(
  'apps\desktop\dist-electron\main.cjs'
  'apps\desktop\dist-electron\preload.cjs'
  'apps\server\dist\bin.mjs'
  'apps\web\dist\index.html'
) | ForEach-Object { Join-Path $RepoRoot $_ }

$missing = $artifacts | Where-Object { -not (Test-Path $_) }
$needsBuild = $false
$reason = ''

if ($ForceBuild) {
  $needsBuild = $true; $reason = 'forced'
} elseif ($missing) {
  $needsBuild = $true; $reason = "missing: $(($missing | Split-Path -Leaf) -join ', ')"
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

if ($needsBuild -and $NoBuild) {
  Write-Host "  build  : STALE ($reason) - running anyway (-NoBuild)" -ForegroundColor Yellow
} elseif ($needsBuild) {
  Write-Host "  build  : stale ($reason) - rebuilding..." -ForegroundColor Yellow
  & pnpm build:desktop
  if ($LASTEXITCODE -ne 0) { throw "build:desktop failed ($LASTEXITCODE)" }
  Write-Host "  build  : done" -ForegroundColor Green
} else {
  Write-Host "  build  : up to date" -ForegroundColor Green
}

# --- diagnostics ---------------------------------------------------------
$electronArgs = @('--trace-warnings')

if ($LagMs -gt 0) {
  $env:T3_EVENT_LOOP_LAG_MS = "$LagMs"
  Remove-Item Env:\T3_EVENT_LOOP_LAG_OFF -ErrorAction SilentlyContinue
  Write-Host "  lag    : reporting stalls >= ${LagMs}ms"
} else {
  $env:T3_EVENT_LOOP_LAG_OFF = '1'
  Write-Host "  lag    : monitor disabled"
}

if ($NetLog) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NetLogPath) | Out-Null
  $electronArgs += "--log-net-log=$NetLogPath"
  Write-Host "  netlog : $NetLogPath"
}

if ($CpuProf) {
  New-Item -ItemType Directory -Force -Path $ProfDir | Out-Null
  # Applies to the backend child, which inherits a copy of this env
  # (DesktopBackendConfiguration.ts). Interval widened to 200us to keep the
  # profile small over a ~60s startup.
  $env:NODE_OPTIONS = "--cpu-prof --cpu-prof-dir=$ProfDir --cpu-prof-interval=200"
  Write-Host "  cpuprof: $ProfDir  (QUIT THE APP NORMALLY or nothing is written)" -ForegroundColor Yellow
}

Write-Host "  args   : $($electronArgs -join ' ')"
Write-Host ''

if ($DryRun) {
  Write-Host "DRY RUN - would execute:" -ForegroundColor Cyan
  Write-Host "  pnpm start:desktop -- $($electronArgs -join ' ')"
  Write-Host "  NODE_OPTIONS=$($env:NODE_OPTIONS)"
  Write-Host "  T3_EVENT_LOOP_LAG_MS=$($env:T3_EVENT_LOOP_LAG_MS)"
  exit 0
}

# --- run -----------------------------------------------------------------
$started = Get-Date
& pnpm start:desktop -- @electronArgs
$code = $LASTEXITCODE

Write-Host ''
Write-Host "exited $code after $([int]((Get-Date) - $started).TotalSeconds)s" -ForegroundColor Cyan
Write-Host 'where to look:'
Write-Host "  stalls : Select-String 'Event loop' `$env:USERPROFILE\.t3\userdata\logs\server-child.log | Select-Object -Last 40"
if ($CpuProf) {
  $profiles = @(Get-ChildItem -Path $ProfDir -Filter *.cpuprofile -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending)
  if ($profiles) {
    Write-Host "  cpuprof: $($profiles.Count) profile(s) in $ProfDir; largest $($profiles[0].Name) ($([int]($profiles[0].Length/1MB))MB)"
  } else {
    Write-Host "  cpuprof: NO PROFILES WRITTEN - the app was killed rather than quit" -ForegroundColor Red
  }
}
if ($NetLog) { Write-Host "  netlog : $NetLogPath" }

if ($KeepOpen) { Write-Host ''; Read-Host 'press Enter to close' | Out-Null }
exit $code
