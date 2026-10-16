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
# Current objective: correlate client disconnects with backend event-loop
# stalls. That needs only the lag monitor and the per-run diagnostics file,
# both of which are cheap.
#
# DISCIPLINE: heavyweight instrumentation is opt-in and gets turned back OFF
# as soon as the measurement it was added for is taken. Leaving it on is not
# free and not neutral -- it perturbs the very window under observation.
$Config = @{
  # OFF. The startup hot path has been captured twice (2026-07-28 and
  # 2026-07-30; see plans/t3code-startup-freeze-deeper-fix.md), so there is
  # nothing left to learn from re-profiling every launch. Worse, the V8
  # sampler runs for the first 90s of startup -- precisely the window where
  # disconnects are being measured -- so leaving it on would distort the
  # numbers it is meant to explain. Set true only to take a new profile, then
  # set it back.
  CpuProf = $false

  # How long to profile from server start, when CpuProf is enabled. The
  # startup burst runs ~62s, so 90 covers it with margin.
  CpuProfSeconds = 90

  # Chromium netlog. Off: the netlog questions (dead saved environments,
  # the homeassistant 404 loop) are already answered and it is just noise now.
  NetLog = $false

  # Event-loop stall reporting threshold in ms (T3_EVENT_LOOP_LAG_MS).
  # 250 catches everything that matters without flooding; 0 disables.
  LagMs = 250

  # Sample per-process host CPU during startup (scripts/sample-host-cpu.ps1).
  #
  # OFF. It answered its question on 2026-08-03 and must not be left on: it was
  # NOT cheap. Its per-second Get-CimInstance made WmiPrvSE plus its own
  # powershell host the single largest CPU consumer on the box -- avg 18.9%,
  # peak 35.4% of a 12-core machine -- and the event-loop stall duty cycle rose
  # 15.2% -> 31.7% between the run without it and the run with it. It measurably
  # worsened the startup window it was measuring.
  #
  # Set true only to take a new attribution sample, then set it back.
  HostCpu = $false

  # How long to sample host CPU. The storm has always ended by ~162s.
  HostCpuSeconds = 240

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

# The toolchain is vite-plus: `vp` supplies node, the package manager, and the
# task runner, and every root package.json script is a `vp run` underneath.
# Call it directly rather than through `pnpm <script>` -- there is no global
# pnpm on this machine any more. It used to come from the Node.js MSI in
# C:\Program Files\nodejs; once that was uninstalled, only corepack's stale
# shims were left, off PATH, and a fresh elevated shell failed with "The term
# 'pnpm' is not recognized" while already-open terminals, with PATH cached
# from before, kept working.
if (-not (Get-Command vp -ErrorAction SilentlyContinue)) {
  throw "vp (vite-plus) not found on PATH. Install it or add $env:USERPROFILE\.vite-plus\bin to PATH."
}

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

# --- dependencies --------------------------------------------------------
# An upstream merge that changes pnpm-lock.yaml leaves node_modules stale, and
# a build against a stale tree fails in confusing ways, or quietly bundles old
# packages. pnpm rewrites node_modules\.modules.yaml at the end of every
# install, so a lockfile newer than that record means `vp i` has not run since
# the merge. Like the build, this is refused while an instance is running:
# pnpm cannot replace Electron's DLLs under a live process (EPERM), and the
# 2026-10-02 v2 merge left node_modules half-purged exactly that way.
$modulesRecord = Join-Path $RepoRoot 'node_modules\.modules.yaml'
$lockfile = Join-Path $RepoRoot 'pnpm-lock.yaml'
$needsInstall = -not (Test-Path $modulesRecord) -or
  ((Get-Item $lockfile).LastWriteTime -gt (Get-Item $modulesRecord).LastWriteTime)
if ($needsInstall -and $Config.Build -ne 'never') {
  Set-ConsoleVisible $true
  if ($already.Count -gt 0) {
    Write-Host '  install : REFUSED - app is running' -ForegroundColor Red
    Write-Host '            pnpm cannot replace Electron files under a live instance.' -ForegroundColor Red
    Write-Host '            Quit the app, then re-run.' -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch {}
    if ($KeepOpen) { Read-Host 'press Enter to close' | Out-Null }
    exit 1
  }
  Write-Host '  install : node_modules is older than pnpm-lock.yaml - running vp i...' -ForegroundColor Yellow
  # pnpm asks for confirmation before recreating node_modules and aborts
  # without a TTY to ask on; CI=true answers yes. Scoped to the install so the
  # build below does not run in CI mode.
  $previousCI = $env:CI
  $env:CI = 'true'
  try {
    # vp.exe is only a launcher: it loads the project's vite-plus out of
    # node_modules, so once node_modules is gone (pnpm purges it when the
    # layout changes) `vp i` itself fails with "Cannot find module". vite-plus
    # keeps the pnpm versions it manages under ~\.vite-plus; bootstrap with the
    # one package.json pins, then vp works again for the build.
    if (Test-Path (Join-Path $RepoRoot 'node_modules\vite-plus\bin\vp')) {
      & vp i
      if ($LASTEXITCODE -ne 0) { throw "vp i failed ($LASTEXITCODE)" }
    } else {
      $pinned = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
      $pnpmVersion = ($pinned -split '@')[-1]
      $pnpmCjs = Join-Path $env:USERPROFILE ".vite-plus\package_manager\pnpm\$pnpmVersion\pnpm\bin\pnpm.cjs"
      if (-not (Test-Path $pnpmCjs)) {
        throw "node_modules is gone and vite-plus has no cached pnpm $pnpmVersion at $pnpmCjs; run 'vp i' from a shell where vp resolves"
      }
      Write-Host "  install : node_modules is gone - bootstrapping with pnpm $pnpmVersion from ~\.vite-plus" -ForegroundColor Yellow
      & node $pnpmCjs install
      if ($LASTEXITCODE -ne 0) { throw "pnpm install failed ($LASTEXITCODE)" }
    }
  } finally {
    $env:CI = $previousCI
  }
  Write-Host '  install : done' -ForegroundColor Green
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
  # Walked by hand, pruning node_modules/dist and every reparse point BEFORE
  # descending. `Get-ChildItem -Recurse` and filtering the paths afterwards
  # hung forever once pnpm 11 started linking workspace packages to each other
  # with directory symlinks (packages\a\node_modules\@t3tools\b -> packages\b,
  # and back again): the recursion followed them in a cycle, pinning a core
  # silently right after `install : done`.
  $skipDirs = @('node_modules', 'dist', 'dist-electron')
  $srcExts = @('.ts', '.tsx', '.mjs', '.css')
  $newestSrc = $null
  $pending = New-Object System.Collections.Generic.Stack[string]
  foreach ($r in $srcRoots) { $pending.Push($r) }
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction SilentlyContinue) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if ($entry.PSIsContainer) {
        if ($skipDirs -notcontains $entry.Name) { $pending.Push($entry.FullName) }
      } elseif ($srcExts -contains $entry.Extension -and
        # Build-generated sources would otherwise re-trigger staleness forever.
        $entry.Name -notlike '*.generated.*' -and
        (-not $newestSrc -or $entry.LastWriteTime -gt $newestSrc.LastWriteTime)) {
        $newestSrc = $entry
      }
    }
  }
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
  # The build is the heaviest thing this launcher does, and it runs elevated on
  # a six-core laptop that is also playing music. `vp run` defaults to four
  # concurrent tasks and each one spawns its own multithreaded bundler, so left
  # alone this takes the whole machine -- capping vp's concurrency alone would
  # not help, because the parallelism that hurts is threads underneath it.
  #
  # --low drops the process tree to BelowNormal; Windows children inherit the
  # priority class at creation, so the bundler and compiler workers come with
  # it. The slot claim stops it colliding with another session's heavy run.
  #
  # Only the BUILD is lowered, never the app -- an editor at BelowNormal would
  # feel worse than a slow build ever does.
  #
  # Best effort: a missing broker must not make this launcher unable to build.
  $broker = Join-Path $env:USERPROFILE '.claude\bin\cpu-slots.mjs'
  if ((Test-Path $broker) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    & node $broker run --slots 2 --low --label 't3code build:desktop' -- vp run build:desktop
  } else {
    Write-Host '  build   : cpu-slots broker unavailable - building at normal priority' -ForegroundColor DarkYellow
    & vp run build:desktop
  }
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

# Per-run diagnostics file. The backend appends one JSON line per event-loop
# stall here. It exists because the two sinks that "should" work do not: the
# desktop's capture of backend stdout into server-child.log silently stopped
# recording, and server.trace.ndjson rotates every ~60-90s, which is shorter
# than the interval between the disconnects being investigated.
$env:T3_DIAGNOSTICS_FILE = Join-Path $RunDir 'diagnostics.ndjson'
Write-Host "  diag    : $($env:T3_DIAGNOSTICS_FILE)"

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

# Host CPU attribution. Runs out-of-process on purpose: it is measuring the
# backend while the backend is starved, so it must not share that event loop and
# must survive the backend stalling. Detached so it never holds up the launcher.
if ($Config.HostCpu) {
  $hostCpuPath = Join-Path $RunDir 'host-cpu.ndjson'
  $samplerScript = Join-Path $PSScriptRoot 'sample-host-cpu.ps1'
  if (Test-Path -LiteralPath $samplerScript) {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$samplerScript`"",
      '-OutFile', "`"$hostCpuPath`"", '-Seconds', "$($Config.HostCpuSeconds)"
    ) | Out-Null
    Write-Host "  hostcpu : first $($Config.HostCpuSeconds)s -> $hostCpuPath"
  } else {
    Write-Host "  hostcpu : SKIPPED, $samplerScript not found" -ForegroundColor Yellow
  }
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
  Write-Host "  vp run start:desktop $($electronArgs -join ' ')"
  Write-Host "  NODE_OPTIONS=$($env:NODE_OPTIONS)"
  try { Stop-Transcript | Out-Null } catch {}
  Remove-Item $RunDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# The installed app shares this build's Electron profile (%APPDATA%\t3code; see
# apps/desktop/scripts/start-electron.mjs), and the Clerk bridge takes Electron's
# single-instance lock on it. While the installed app runs, this build is the
# second instance: it hands off to that app and exits 0 within ~2s, with nothing
# in any log -- which looked exactly like "the launcher did nothing". Its process
# is named after the product, not electron.exe, so the check above misses it.
$installed = @(Get-Process -Name 'T3 Code*' -ErrorAction SilentlyContinue)
if ($installed.Count -gt 0) {
  Set-ConsoleVisible $true
  Write-Host "  BLOCKED : the installed T3 Code app is running (pid $($installed[0].Id))." -ForegroundColor Red
  Write-Host '            It holds the single-instance lock on the shared profile, so this' -ForegroundColor Red
  Write-Host '            build would exit immediately. Quit it (tray icon > Quit), then re-run.' -ForegroundColor Red
  try { Stop-Transcript | Out-Null } catch {}
  if ($KeepOpen) { Read-Host 'press Enter to close' | Out-Null }
  exit 1
}

# --- run -----------------------------------------------------------------
Write-Host 'App starting. Quit it normally when done.' -ForegroundColor Green
Write-Host ''

# Back to hidden for the launch itself (the build, if any, is done).
if ($Config.HideConsole -and -not $DryRun) { Set-ConsoleVisible $false }

$started = Get-Date
& vp run start:desktop @electronArgs
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
