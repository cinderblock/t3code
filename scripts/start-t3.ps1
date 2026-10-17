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
  3. Reinstalls dependencies when pnpm-lock.yaml moved, and rebuilds if any
     source file is newer than the build artifacts. The app runs bundles
     (apps/server/dist/bin.mjs, apps/desktop/dist-electron/main.cjs), NOT
     source, so a stale bundle silently runs old code. That has already cost
     one debugging session.
  4. Stops the T3 Code that is already running (this build or the installed
     app): asks its window to close, then forces it after a grace period. The
     build runs BEFORE this, so a failed build leaves the running app alone.
     An install cannot: pnpm cannot replace Electron's files under a live app.
  5. Records start/stop markers so the resulting logs can be sliced to exactly
     this run (see "Run markers" below).
  6. Launches the app and waits for its backend to answer. An app that exits
     early, or a backend that never answers, brings the console back with the
     tail of the log.

Failure handling: the console is hidden, so a failure must never be silent.
Any error shows the console and waits for Enter. A watchdog timer, running on
its own thread, shows the console if a phase runs far longer than it should,
which is what a hang looks like from outside (the 2026-10-16 staleness scan
looped through pnpm symlinks at 100% of a core with no window at all). A
second launch while one is still starting is refused.

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

# A hang inside this script blocks its only thread, so nothing written in
# PowerShell can notice it. This timer runs on a thread-pool thread instead.
# C# 5 syntax: Windows PowerShell 5.1 compiles it with the .NET Framework csc.
if (-not ('T3.Watchdog' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace T3 {
  public static class Watchdog {
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    static readonly object Gate = new object();
    static Timer timer;
    public static string LogPath;

    public static void Arm(string phase, int seconds, string hint) {
      lock (Gate) {
        Disarm();
        timer = new Timer(_ => Fire(phase, seconds, hint), null, seconds * 1000L, Timeout.Infinite);
      }
    }

    public static void Disarm() {
      lock (Gate) {
        if (timer != null) { timer.Dispose(); timer = null; }
      }
    }

    static void Fire(string phase, int seconds, string hint) {
      string line = String.Format("{0:o} STUCK? '{1}' is still running after {2}s. {3}",
        DateTime.Now, phase, seconds, hint);
      try { ShowWindow(GetConsoleWindow(), 5); } catch { }
      try {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine();
        Console.WriteLine("  " + line);
        Console.ResetColor();
      } catch { }
      try { if (LogPath != null) File.AppendAllText(LogPath, line + Environment.NewLine); } catch { }
    }
  }
}
'@
}

function Start-Phase {
  param([string]$Name, [int]$Seconds)
  [T3.Watchdog]::Arm($Name, $Seconds,
    'If nothing is changing, close this window and run the launcher again.')
}

# Every terminating error lands here. Without it, a throw in a hidden console
# (a failed build, a failed install) closed the window with no trace on screen.
trap {
  [T3.Watchdog]::Disarm()
  Set-ConsoleVisible $true
  Write-Host ''
  Write-Host "  FAILED  : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "            $($_.InvocationInfo.PositionMessage -replace "`n", "`n            ")" -ForegroundColor DarkRed
  if ($RunDir) { Write-Host "  log     : $(Join-Path $RunDir 'launcher.log')" }
  try { Stop-Transcript | Out-Null } catch {}
  if ($KeepOpen) { Read-Host 'press Enter to close' | Out-Null }
  exit 1
}

# Main processes of a running T3 Code: this checkout's Electron (main window,
# helpers and the backend all run electron.exe from node_modules) and the
# installed app, which shares this build's profile and single-instance lock.
# Matching on the executable path keeps worktree dev servers, whose Electron
# lives under their own node_modules, out of it.
function Get-T3Processes {
  $electronRoot = (Join-Path $RepoRoot 'node_modules') + '\'
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue -Filter (
      "Name = 'electron.exe' OR Name LIKE 'T3 Code%' OR Name = 'pwsh.exe' OR Name = 'powershell.exe'"))
  [pscustomobject]@{
    Apps      = @($all | Where-Object {
        ($_.Name -eq 'electron.exe' -and $_.ExecutablePath -and
          $_.ExecutablePath.StartsWith($electronRoot, [StringComparison]::OrdinalIgnoreCase)) -or
        $_.Name -like 'T3 Code*'
      })
    # Earlier runs of this launcher, waiting on the app they started.
    Launchers = @($all | Where-Object {
        $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.ProcessId -ne $PID -and
        $_.CommandLine -like '*start-t3.ps1*'
      })
  }
}

function Wait-Until {
  param([scriptblock]$Done, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while (-not (& $Done)) {
    if ((Get-Date) -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 500
  }
  $true
}

function Stop-RunningT3 {
  $found = Get-T3Processes
  if ($found.Apps.Count -eq 0 -and $found.Launchers.Count -eq 0) {
    Write-Host '  stop    : no T3 Code running'
    return $false
  }
  Write-Host "  stop    : $($found.Apps.Count) T3 Code process(es), $($found.Launchers.Count) earlier launcher(s)" -ForegroundColor Yellow
  if ($DryRun) {
    $found.Apps + $found.Launchers | ForEach-Object { Write-Host "            would stop $($_.ProcessId) $($_.Name)" }
    return $false
  }
  Start-Phase 'stopping the running app' 90

  # Closing the window quits the app on Windows (window-all-closed -> app.quit),
  # which stops the backend cleanly. An earlier launcher then sees a clean exit
  # and writes its own run.json.
  foreach ($p in $found.Apps) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { [void]$proc.CloseMainWindow() }
  }
  $closed = Wait-Until { (Get-T3Processes).Apps.Count -eq 0 } 20

  if (-not $closed) {
    Write-Host '            did not close within 20s - forcing' -ForegroundColor Yellow
    # Launchers first: one whose app is killed reports a failed run and waits
    # for Enter, which would pop up a stray console.
    (Get-T3Processes).Launchers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    (Get-T3Processes).Apps | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    [void](Wait-Until { (Get-T3Processes).Apps.Count -eq 0 } 15)
  }
  if (-not (Wait-Until { (Get-T3Processes).Launchers.Count -eq 0 } 10)) {
    (Get-T3Processes).Launchers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  [T3.Watchdog]::Disarm()

  $left = (Get-T3Processes).Apps
  if ($left.Count -gt 0) {
    throw "Could not stop the running T3 Code (pid $(($left | ForEach-Object ProcessId) -join ', '))."
  }
  Write-Host "            stopped$(if ($closed) { ' (closed normally)' } else { ' (forced)' })" -ForegroundColor Green
  return $true
}

# The backend is the electron.exe running apps\server\dist\bin.mjs. Its port is
# usually 3773 but moves when that is taken, so read it off the process.
function Get-T3BackendPort {
  $backend = (Get-T3Processes).Apps | Where-Object { $_.CommandLine -like '*apps\server\dist\bin.mjs*' } |
    Select-Object -First 1
  if (-not $backend) { return $null }
  Get-NetTCPConnection -State Listen -OwningProcess $backend.ProcessId -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalPort -First 1
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

[T3.Watchdog]::LogPath = Join-Path $RunDir 'watchdog.log'

# One launch at a time, held until the app is up. A second click while the
# first is still building would otherwise stop the app the first one starts.
# An abandoned mutex (a launcher that was killed) is ours to take.
$launchMutex = New-Object System.Threading.Mutex($false, 'Local\T3CodeDesktopLauncher')
$ownsLaunch = $false
try { $ownsLaunch = $launchMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsLaunch = $true }
if (-not $ownsLaunch) {
  throw 'Another launch of T3 Code is still starting. Wait for it, or close its window first.'
}

$running = Get-T3Processes
$appRunning = $running.Apps.Count -gt 0
if ($appRunning) {
  Write-Host "  running : T3 Code is running; it will be stopped before the new launch" -ForegroundColor Yellow
}
$stoppedPrevious = $false

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
$didInstall = $false
if ($needsInstall -and $Config.Build -ne 'never' -and $DryRun) {
  Write-Host '  install : needed - node_modules is older than pnpm-lock.yaml (dry run, skipped)' -ForegroundColor Yellow
} elseif ($needsInstall -and $Config.Build -ne 'never') {
  Set-ConsoleVisible $true
  if ($appRunning) {
    if ($BuildOnly) {
      throw 'Dependencies need reinstalling, which cannot happen under the running app. Quit it, then re-run.'
    }
    $stoppedPrevious = Stop-RunningT3
    $appRunning = $false
  }
  Start-Phase 'installing dependencies' 1500
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
  [T3.Watchdog]::Disarm()
  $didInstall = $true
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

Start-Phase 'checking whether the build is current' 120
if ($Config.Build -eq 'always') {
  $needsBuild = $true; $reason = 'Build=always'
} elseif ($didInstall) {
  # Sources may be older than the last build, but the packages bundled into it changed.
  $needsBuild = $true; $reason = 'dependencies were reinstalled'
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
[T3.Watchdog]::Disarm()

# A rebuild regenerates content-hashed web chunks (PreviewPanel-<hash>.js and
# friends). A RUNNING instance already holds the old names in its loaded entry
# chunk, so any lazy route it has not visited yet fails with "Failed to fetch
# dynamically imported module" until the window is reloaded. A normal launch
# stops that instance right after building, so this only matters for a
# pre-warm, which leaves it running.
if ($needsBuild -and $appRunning -and $BuildOnly -and $Config.Build -ne 'never') {
  throw 'Pre-warming now would swap the web chunks out from under the running app and break its lazy routes. Quit the app, then re-run.'
}

$didBuild = $false
if ($needsBuild -and $Config.Build -eq 'never') {
  Write-Host "  build   : STALE ($reason) - running anyway (Build=never)" -ForegroundColor Yellow
} elseif ($needsBuild -and $DryRun) {
  Write-Host "  build   : stale ($reason) - would rebuild (dry run, skipped)" -ForegroundColor Yellow
} elseif ($needsBuild) {
  # A build takes minutes; show the console so it does not look hung, then
  # hide it again before the app launches. The running app, if any, keeps
  # running meanwhile and is stopped only once there is a build to replace it.
  if ($Config.HideConsole) { Set-ConsoleVisible $true }
  Start-Phase 'building' 1200
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
  if ($LASTEXITCODE -ne 0) {
    throw "build:desktop failed ($LASTEXITCODE)$(if ($appRunning) { '. The running app was left alone.' })"
  }
  [T3.Watchdog]::Disarm()
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

# --- stop the running app ------------------------------------------------
# Both the installed app and an earlier run of this build. The installed app
# shares this build's Electron profile (%APPDATA%\t3code; see
# apps/desktop/scripts/start-electron.mjs) and its single-instance lock, so
# while it runs, this build hands off to it and exits 0 within ~2s with nothing
# in any log -- which looked exactly like "the launcher did nothing".
if (-not $stoppedPrevious) { $stoppedPrevious = Stop-RunningT3 }

if ($DryRun) {
  Write-Host ''
  Write-Host 'DRY RUN - would execute:' -ForegroundColor Cyan
  Write-Host "  vp run start:desktop $($electronArgs -join ' ')"
  Write-Host "  NODE_OPTIONS=$($env:NODE_OPTIONS)"
  try { Stop-Transcript | Out-Null } catch {}
  Remove-Item $RunDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# --- run -----------------------------------------------------------------
Write-Host 'App starting. Quit it normally when done.' -ForegroundColor Green
Write-Host ''

# vp.exe directly, not through PATH: a terminal that already has a project's
# node_modules\.bin on PATH would resolve vp.ps1, which Process.Start cannot run.
$vpExe = Join-Path $env:USERPROFILE '.vite-plus\bin\vp.exe'
if (-not (Test-Path $vpExe)) {
  $vpExe = (Get-Command vp -CommandType Application | Where-Object { $_.Source -like '*.exe' } |
      Select-Object -First 1).Source
}
$startInfo = New-Object System.Diagnostics.ProcessStartInfo $vpExe
$startInfo.Arguments = (@('run', 'start:desktop') + $electronArgs | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
$startInfo.UseShellExecute = $false
$startInfo.WorkingDirectory = $RepoRoot

$started = Get-Date
$app = [System.Diagnostics.Process]::Start($startInfo)

# Wait for the backend to answer, so a launch that never comes up is reported
# instead of leaving a hidden console and no window. The app retries its own
# backend for a while (a 60s readiness timeout has been seen on a healthy run),
# so this only warns; it never kills what it started.
$ReadyDeadlineSeconds = 300
$readySeconds = $null
$readyDeadline = $started.AddSeconds($ReadyDeadlineSeconds)
while (-not $app.HasExited -and $null -eq $readySeconds -and (Get-Date) -lt $readyDeadline) {
  Start-Sleep -Seconds 1
  $port = Get-T3BackendPort
  if (-not $port) { continue }
  try {
    $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$port/.well-known/t3/environment" -UseBasicParsing -TimeoutSec 3
    if ($probe.StatusCode -eq 200) { $readySeconds = [int]((Get-Date) - $started).TotalSeconds }
  } catch {}
}

function Show-LogTail {
  if (-not (Test-Path $serverChildLog)) { return }
  Write-Host '  last lines of server-child.log from this run:' -ForegroundColor DarkYellow
  Get-Content $serverChildLog -Tail 25 | ForEach-Object { Write-Host "    $_" }
}

$exitedEarly = $null -eq $readySeconds -and $app.HasExited
if ($null -ne $readySeconds) {
  Write-Host "  ready   : backend answered after ${readySeconds}s" -ForegroundColor Green
  # Up and running: another launch may now replace it.
  $launchMutex.ReleaseMutex(); $ownsLaunch = $false
  if ($Config.HideConsole) { Set-ConsoleVisible $false }
} elseif ($exitedEarly) {
  Set-ConsoleVisible $true
  Write-Host "  EXITED  : the app quit after $([int]((Get-Date) - $started).TotalSeconds)s, before its backend answered (exit $($app.ExitCode))." -ForegroundColor Red
  Show-LogTail
} else {
  Set-ConsoleVisible $true
  Write-Host "  SLOW    : the backend has not answered after ${ReadyDeadlineSeconds}s. The app may still come up;" -ForegroundColor Red
  Write-Host '            if it does not, quit it and run the launcher again.' -ForegroundColor Red
  Show-LogTail
  $launchMutex.ReleaseMutex(); $ownsLaunch = $false
}

$app.WaitForExit()
$code = $app.ExitCode
$ended = Get-Date
if ($ownsLaunch) { $launchMutex.ReleaseMutex() }

# A failed run must not disappear silently, and neither may one that quit
# before it came up (exit 0 there is the single-instance handoff).
if ($code -ne 0 -or $exitedEarly) {
  Set-ConsoleVisible $true
  if ($code -eq 0) { $code = 1 }
}
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
  reinstalled       = $didInstall
  stoppedPrevious   = $stoppedPrevious
  readySeconds      = $readySeconds
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
