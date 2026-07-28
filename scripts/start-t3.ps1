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
  [switch]$KeepOpen,
  # Build and write the stamp, then stop without launching. Used to pre-warm
  # the bundles so the next real run starts immediately. Building by hand
  # instead would leave no stamp, and the next launch would rebuild.
  [switch]$BuildOnly
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
  # Profile the backend's startup. Written on a timer by the server itself, so
  # unlike --cpu-prof it does not depend on a clean exit.
  CpuProf = $true

  # How long to profile from server start. The startup burst under
  # investigation runs ~62s, so 90 covers it with margin.
  CpuProfSeconds = 90

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

  # Run with no visible console at all. It is shown only while a build is
  # running (the one part worth watching) and on failure. Everything printed is
  # captured in the run's launcher.log either way.
  HideConsole = $true
}
# =====================================================================

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not ('T3.Win32' -as [type])) {
  Add-Type -Namespace T3 -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
}
$SW_HIDE = 0
$SW_SHOW = 5

function Set-ConsoleVisible {
  param([bool]$Visible)
  $h = [T3.Win32]::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) {
    [void][T3.Win32]::ShowWindow($h, $(if ($Visible) { $SW_SHOW } else { $SW_HIDE }))
  }
}

# Identity of the bytes that will actually execute. The commit at launch time
# describes the SOURCE tree; it does not prove which build is running, which is
# precisely how a month-old bundle once silently undid a database repair. The
# hash is the authoritative answer -- identical hash means identical bytes.
function Get-ArtifactFacts {
  param([string[]]$Paths, [string]$Root)
  foreach ($p in $Paths) {
    if (-not (Test-Path $p)) { continue }
    $item = Get-Item $p
    [ordered]@{
      path     = $item.FullName.Replace("$Root\", '')
      sizeBytes = $item.Length
      mtimeUtc = $item.LastWriteTimeUtc.ToString('o')
      sha256   = (Get-FileHash -Path $p -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
    }
  }
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
# A dry run must not claim to be the latest real run -- that pointer is how the
# most recent profile/log slice gets found.
if (-not $DryRun -and -not $BuildOnly) {
  Set-Content -Path (Join-Path $RunsRoot 'latest.txt') -Value $RunDir -Encoding utf8
}

$serverChildLog = Join-Path $env:USERPROFILE '.t3\userdata\logs\server-child.log'
$startOffset = if (Test-Path $serverChildLog) { (Get-Item $serverChildLog).Length } else { 0 }

try { Start-Transcript -Path (Join-Path $RunDir 'launcher.log') -Force | Out-Null } catch {}

# Hidden from here on. The elevated console is only interesting while a build
# runs or when something fails; both re-show it explicitly below.
if ($Config.HideConsole -and -not $DryRun) { Set-ConsoleVisible $false }

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
# Written next to the artifacts (dist-electron is gitignored) so the bundles
# carry the commit they were produced from, and so staleness has a reference
# point that is written strictly LAST.
$stampPath = Join-Path $RepoRoot 'apps\desktop\dist-electron\.t3-build-stamp.json'
$buildStamp = $null
if (Test-Path $stampPath) {
  try { $buildStamp = Get-Content $stampPath -Raw | ConvertFrom-Json } catch {}
}

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
  # Compare against the build STAMP, not artifact mtimes. The build writes its
  # own outputs at different times AND regenerates sources mid-build (e.g.
  # apps/desktop/src/preview/AnnotationStyles.generated.ts, written after
  # apps/web/dist/index.html). Comparing "newest source" to "oldest artifact"
  # therefore reported stale on every run, forever, and rebuilt every launch.
  # The stamp is written after the build completes, so nothing the build itself
  # touches can post-date it.
  $reference = $null
  if ($buildStamp -and $buildStamp.builtAtUtc) {
    try { $reference = [datetime]::Parse($buildStamp.builtAtUtc).ToLocalTime() } catch {}
  }
  if (-not $reference) {
    $reference = ($artifacts | ForEach-Object { (Get-Item $_).LastWriteTime } |
      Sort-Object | Select-Object -First 1)
  }

  $srcRoots = @('apps\server\src', 'apps\desktop\src', 'apps\desktop\scripts',
    'apps\web\src', 'packages') | ForEach-Object { Join-Path $RepoRoot $_ } |
    Where-Object { Test-Path $_ }
  $newestSrc = Get-ChildItem -Path $srcRoots -Recurse -File -Include *.ts, *.tsx, *.mjs, *.css 2>$null |
    Where-Object {
      $_.FullName -notmatch '\\(node_modules|dist|dist-electron)\\' -and
      # Build-generated sources would otherwise re-trigger staleness forever.
      $_.Name -notlike '*.generated.*'
    } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newestSrc -and $newestSrc.LastWriteTime -gt $reference) {
    $needsBuild = $true
    $reason = "$($newestSrc.Name) is newer than the last build"
  }
}

# A rebuild regenerates content-hashed web chunks (PreviewPanel-<hash>.js and
# friends). A RUNNING instance already holds the old names in its loaded entry
# chunk, so any lazy route it has not visited yet fails with "Failed to fetch
# dynamically imported module" until the window is reloaded. Harmless but
# confusing, and entirely avoidable.
if ($needsBuild -and $already.Count -gt 0 -and $Config.Build -ne 'never') {
  if ($BuildOnly) {
    Write-Host '  build   : REFUSED - app is running' -ForegroundColor Red
    Write-Host '            Pre-warming now would swap the web chunks out from under it' -ForegroundColor Red
    Write-Host '            and break its lazy routes. Quit the app, then re-run.' -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    Remove-Item $RunDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host '  WARNING : rebuilding while an instance is running will break that' -ForegroundColor Yellow
  Write-Host '            instance lazy routes until it is reloaded.' -ForegroundColor Yellow
}

$didBuild = $false
if ($needsBuild -and $Config.Build -eq 'never') {
  Write-Host "  build   : STALE ($reason) - running anyway (Build=never)" -ForegroundColor Yellow
} elseif ($needsBuild) {
  # A build takes minutes; show the console so it does not look hung, then
  # hide it again before the app launches.
  if ($Config.HideConsole -and -not $DryRun) { Set-ConsoleVisible $true }
  Write-Host "  build   : stale ($reason) - rebuilding..." -ForegroundColor Yellow
  & pnpm build:desktop
  if ($LASTEXITCODE -ne 0) { throw "build:desktop failed ($LASTEXITCODE)" }
  $didBuild = $true
  # After the build, so a wiped dist-electron can't take the stamp with it.
  [ordered]@{
    builtAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    commit     = $sha
    branch     = $branch
    dirty      = [bool]$dirty
    builtBy    = 'start-t3.ps1'
  } | ConvertTo-Json | Set-Content -Path $stampPath -Encoding utf8
  Write-Host "  build   : done" -ForegroundColor Green
} else {
  Write-Host "  build   : up to date" -ForegroundColor Green
}

# --- bundle identity -----------------------------------------------------
if ($didBuild -and (Test-Path $stampPath)) {
  try { $buildStamp = Get-Content $stampPath -Raw | ConvertFrom-Json } catch {}
}
$artifactFacts = @(Get-ArtifactFacts -Paths $artifacts -Root $RepoRoot)

if ($buildStamp) {
  $stampDirty = if ($buildStamp.dirty) { ' (dirty)' } else { '' }
  if ($buildStamp.commit -ne $sha) {
    Write-Host "  bundles : built from $($buildStamp.commit)$stampDirty at $($buildStamp.builtAtUtc)" -ForegroundColor Yellow
    Write-Host "            HEAD is $sha - RUNNING A DIFFERENT COMMIT THAN THE WORKING TREE" -ForegroundColor Red
  } else {
    Write-Host "  bundles : built from $($buildStamp.commit)$stampDirty at $($buildStamp.builtAtUtc)" -ForegroundColor Green
  }
} else {
  Write-Host '  bundles : no build stamp - built outside this launcher, commit unknown' -ForegroundColor Yellow
}
foreach ($a in $artifactFacts) {
  Write-Host "            $($a.sha256)  $($a.path)"
}

if ($BuildOnly) {
  Write-Host ''
  Write-Host 'BUILD ONLY - bundles are warm; next run will skip the build.' -ForegroundColor Green
  try { Stop-Transcript | Out-Null } catch {}
  Remove-Item $RunDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
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
  # NOT NODE_OPTIONS=--cpu-prof. That never reached the backend -- it profiled
  # pnpm, vite-plus and the Electron main process instead (four profiles, none
  # of them the server), and covered the whole session at 20-200MB each. The
  # server profiles itself instead; see apps/server/src/observability/CpuProfiler.ts.
  $env:T3_CPU_PROF_DIR = $profDir
  $env:T3_CPU_PROF_SECONDS = "$($Config.CpuProfSeconds)"
  Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
  Write-Host "  cpuprof : backend, first $($Config.CpuProfSeconds)s -> $profDir" -ForegroundColor Yellow
  Write-Host "            Written on a timer, so quitting early is fine." -ForegroundColor Yellow
} else {
  Remove-Item Env:\T3_CPU_PROF_DIR -ErrorAction SilentlyContinue
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
  Remove-Item $RunDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# --- run -----------------------------------------------------------------
Write-Host 'App starting. Quit it normally when done.' -ForegroundColor Green
Write-Host ''

# Back to hidden for the launch itself (the build, if any, is done).
if ($Config.HideConsole -and -not $DryRun) { Set-ConsoleVisible $false }

$started = Get-Date
& pnpm start:desktop -- @electronArgs
$code = $LASTEXITCODE
$ended = Get-Date

# A failed run must not disappear silently.
if ($code -ne 0) { Set-ConsoleVisible $true }
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
  # Which bytes actually ran. buildStamp.commit is the commit the bundles were
  # produced from, which is the answer to "which version is running" -- the
  # top-level `commit` above is only the source tree at launch.
  buildStamp        = $buildStamp
  bundleCommit      = if ($buildStamp) { $buildStamp.commit } else { $null }
  bundleMatchesHead = if ($buildStamp) { $buildStamp.commit -eq $sha } else { $null }
  artifacts         = $artifactFacts
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
# Only pause on failure; a clean run should close without asking, since the
# whole point is to leave one window on screen.
if ($KeepOpen -and $code -ne 0) {
  Set-ConsoleVisible $true
  Write-Host ''
  Read-Host 'run failed - press Enter to close' | Out-Null
}
exit $code
