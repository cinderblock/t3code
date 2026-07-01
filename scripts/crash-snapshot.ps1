<#
.SYNOPSIS
  Snapshot the most recent T3 Code log activity into a single .zip for triage.

.DESCRIPTION
  Pulls the tail of every relevant log source (desktop main, server child, Effect
  trace NDJSON files, per-session provider logs, dev runner log) within a time
  window, plus environment metadata, and packages everything into one zip.

  Captures from both:
    - %USERPROFILE%\.t3\dev\logs\        (source-built dev session)
    - %USERPROFILE%\.t3\userdata\logs\   (installed prod app)

.PARAMETER Minutes
  How far back in time to include log entries. Default 3.

.PARAMETER Note
  Free-text describing what happened. Written to note.txt in the zip.

.PARAMETER Output
  Path for the resulting zip. Defaults to
  <repo>\.crash-reports\snapshot-<yyyyMMdd-HHmmss>.zip.

.PARAMETER DevOnly
  Skip the installed prod app's log root.

.PARAMETER ProdOnly
  Skip the source-built dev session's log root.

.PARAMETER AllProviderSessions
  Include every provider/<uuid>.log file regardless of modification time.
  Default behavior keeps only those touched within the window.

.EXAMPLE
  pwsh scripts\crash-snapshot.ps1 -Minutes 3 -Note "crash when switching session in Claude tab"
#>

[CmdletBinding()]
param(
  [int]$Minutes = 3,
  [string]$Note = "",
  [string]$Output = "",
  [switch]$DevOnly,
  [switch]$ProdOnly,
  [switch]$AllProviderSessions
)

$ErrorActionPreference = "Stop"

$vpBin = Join-Path $env:USERPROFILE ".vite-plus\bin"
if (Test-Path $vpBin) { $env:Path = "$vpBin;$env:Path" }

function Write-Info($msg)  { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Done($msg)  { Write-Host "  $msg" -ForegroundColor Green }

$repoRoot = Split-Path -Parent $PSScriptRoot
$snapshotTime = Get-Date
$cutoff = $snapshotTime.AddMinutes(-1 * $Minutes)
$cutoffUnixNano = [long]([DateTimeOffset]$cutoff).ToUnixTimeMilliseconds() * 1000000L

if (-not $Output) {
  $reportsDir = Join-Path $repoRoot ".crash-reports"
  if (-not (Test-Path $reportsDir)) {
    New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
  }
  $stamp = $snapshotTime.ToString("yyyyMMdd-HHmmss")
  $Output = Join-Path $reportsDir "snapshot-$stamp.zip"
}

$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("t3code-snapshot-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

Write-Host "T3 Code crash snapshot" -ForegroundColor White
Write-Info "window     : last $Minutes minute(s)  (>= $($cutoff.ToString('s')))"
Write-Info "staging    : $workRoot"
Write-Info "output     : $Output"

$t3Home = if ($env:T3_HOME) { $env:T3_HOME } else { Join-Path $env:USERPROFILE ".t3" }
$roots = @()
if (-not $ProdOnly) { $roots += [pscustomobject]@{ Name="dev";      Path = Join-Path $t3Home "dev\logs" } }
if (-not $DevOnly)  { $roots += [pscustomobject]@{ Name="userdata"; Path = Join-Path $t3Home "userdata\logs" } }

function Get-TailWithinWindow {
  param(
    [string]$Path,
    [datetime]$Cutoff,
    [long]$CutoffNano,
    [int]$MaxLinesFallback = 5000
  )

  if (-not (Test-Path $Path)) { return $null }

  $isNdjson = $Path -match '\.ndjson(\.\d+)?$'

  try {
    if ($isNdjson) {
      $lines = Get-Content -LiteralPath $Path -ReadCount 0 -ErrorAction Stop
      $kept = New-Object System.Collections.Generic.List[string]
      foreach ($line in $lines) {
        if (-not $line) { continue }
        $startNano = $null
        $m = [regex]::Match($line, '"startTimeUnixNano"\s*:\s*"?(\d+)"?')
        if ($m.Success) { $startNano = [long]$m.Groups[1].Value }
        else {
          $m2 = [regex]::Match($line, '"timestamp"\s*:\s*"([^"]+)"')
          if ($m2.Success) {
            try { $ts = [datetimeoffset]::Parse($m2.Groups[1].Value); $startNano = $ts.ToUnixTimeMilliseconds() * 1000000L } catch {}
          }
        }
        if (($null -eq $startNano) -or ($startNano -ge $CutoffNano)) {
          $kept.Add($line) | Out-Null
        }
      }
      return ,@($kept.ToArray())
    }

    $lines = Get-Content -LiteralPath $Path -ReadCount 0 -ErrorAction Stop
    $kept = New-Object System.Collections.Generic.List[string]
    $tsRegex = [regex]'^\s*\[(\d{4}-\d{2}-\d{2}T[\d:.\-Z+]+)\]'
    $tsRegexBracket = [regex]'^\s*\[(\d{2}:\d{2}:\d{2}\.\d+)\]'
    $today = (Get-Date).Date
    $keepRest = $false
    foreach ($line in $lines) {
      $passed = $false
      $m = $tsRegex.Match($line)
      if ($m.Success) {
        try {
          $ts = [datetimeoffset]::Parse($m.Groups[1].Value).LocalDateTime
          $passed = ($ts -ge $Cutoff)
        } catch { $passed = $true }
        $keepRest = $passed
      } else {
        $m2 = $tsRegexBracket.Match($line)
        if ($m2.Success) {
          try {
            $ts = [datetime]::ParseExact($m2.Groups[1].Value, "HH:mm:ss.fff", $null)
            $tsFull = $today.Add($ts.TimeOfDay)
            $passed = ($tsFull -ge $Cutoff)
          } catch { $passed = $true }
          $keepRest = $passed
        } else {
          $passed = $keepRest
        }
      }
      if ($passed) { $kept.Add($line) | Out-Null }
    }
    if ($kept.Count -eq 0 -and $lines.Count -gt 0) {
      $tailStart = [Math]::Max(0, $lines.Count - $MaxLinesFallback)
      $kept.AddRange([string[]]($lines[$tailStart..($lines.Count - 1)]))
    }
    return ,@($kept.ToArray())
  } catch {
    Write-Warn2 "read failed: $Path -- $($_.Exception.Message)"
    return ,@()
  }
}

function Copy-RecentProviderSessions {
  param(
    [string]$ProviderDir,
    [string]$DestDir,
    [datetime]$Cutoff,
    [switch]$All
  )
  if (-not (Test-Path $ProviderDir)) { return 0 }
  $candidates = if ($All) {
    Get-ChildItem -LiteralPath $ProviderDir -File -Filter "*.log"
  } else {
    Get-ChildItem -LiteralPath $ProviderDir -File -Filter "*.log" | Where-Object { $_.LastWriteTime -ge $Cutoff }
  }
  if (-not $candidates) { return 0 }
  New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
  foreach ($f in $candidates) {
    try {
      $fs = [System.IO.File]::Open($f.FullName, 'Open', 'Read', 'ReadWrite')
      $sr = New-Object System.IO.StreamReader($fs)
      $content = $sr.ReadToEnd()
      $sr.Close(); $fs.Close()
      Set-Content -LiteralPath (Join-Path $DestDir $f.Name) -Value $content -NoNewline
    } catch {
      Write-Warn2 "skip provider $($f.Name): $($_.Exception.Message)"
    }
  }
  return $candidates.Count
}

foreach ($root in $roots) {
  if (-not (Test-Path $root.Path)) {
    Write-Warn2 "skip root [$($root.Name)] (missing): $($root.Path)"
    continue
  }
  Write-Info "scanning  [$($root.Name)] $($root.Path)"
  $destRoot = Join-Path $workRoot ("logs-" + $root.Name)
  New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

  $files = Get-ChildItem -LiteralPath $root.Path -File | Where-Object {
    $_.Name -match '\.(log|ndjson)(\.\d+)?$'
  } | Where-Object {
    # Skip any file whose mtime is older than the cutoff — it can't contain in-window entries.
    $_.LastWriteTime -ge $cutoff
  }
  foreach ($f in $files) {
    $kept = Get-TailWithinWindow -Path $f.FullName -Cutoff $cutoff -CutoffNano $cutoffUnixNano
    if ($null -eq $kept) { continue }
    $destPath = Join-Path $destRoot $f.Name
    if ($kept.Count -eq 0) {
      "" | Set-Content -LiteralPath $destPath
    } else {
      [System.IO.File]::WriteAllLines($destPath, $kept)
    }
    Write-Info "  $($f.Name) -> $($kept.Count) line(s)"
  }

  $providerSrc = Join-Path $root.Path "provider"
  if (Test-Path $providerSrc) {
    $providerDest = Join-Path $destRoot "provider"
    $count = Copy-RecentProviderSessions -ProviderDir $providerSrc -DestDir $providerDest -Cutoff $cutoff -All:$AllProviderSessions
    Write-Info "  provider sessions copied: $count"
  }

  $terminalsSrc = Join-Path $root.Path "terminals"
  if (Test-Path $terminalsSrc) {
    $terminalsDest = Join-Path $destRoot "terminals"
    New-Item -ItemType Directory -Force -Path $terminalsDest | Out-Null
    $tfiles = Get-ChildItem -LiteralPath $terminalsSrc -File | Where-Object { $_.LastWriteTime -ge $cutoff }
    foreach ($tf in $tfiles) {
      try { Copy-Item -LiteralPath $tf.FullName -Destination $terminalsDest -ErrorAction Stop } catch {}
    }
    Write-Info "  terminal logs copied: $($tfiles.Count)"
  }
}

$repoDevLog = Join-Path $repoRoot ".logs\dev-desktop.log"
if (Test-Path $repoDevLog) {
  $kept = Get-TailWithinWindow -Path $repoDevLog -Cutoff $cutoff -CutoffNano $cutoffUnixNano
  if ($null -ne $kept) {
    [System.IO.File]::WriteAllLines((Join-Path $workRoot "dev-runner.log"), $kept)
    Write-Info "dev-runner.log -> $($kept.Count) line(s)"
  }
}

Write-Info "collecting metadata"
$gitInfo = [ordered]@{ available = $false }
try {
  Push-Location $repoRoot
  $sha = (& git rev-parse HEAD) 2>$null
  $branch = (& git rev-parse --abbrev-ref HEAD) 2>$null
  $statusLines = (& git status --short) 2>$null
  if ($sha) {
    $gitInfo = [ordered]@{
      available = $true
      commit    = $sha.Trim()
      branch    = $branch.Trim()
      dirty     = [bool]($statusLines -and $statusLines.Trim().Length -gt 0)
      shortStat = ($statusLines -split "`n" | Select-Object -First 30) -join "`n"
    }
  }
  Pop-Location
} catch { try { Pop-Location } catch {} }

$processes = @()
try {
  $processes = Get-CimInstance Win32_Process -ErrorAction Stop |
    Where-Object {
      $_.Name -match 'T3 Code|t3code|t3-code|electron' -or
      $_.CommandLine -match 't3code|@t3tools|dev-electron\.mjs|dev-runner\.ts'
    } |
    Select-Object @{N='pid';E={$_.ProcessId}}, @{N='ppid';E={$_.ParentProcessId}}, Name,
      @{N='startTime';E={ $_.CreationDate }},
      @{N='cmd';E={ if ($_.CommandLine) { if ($_.CommandLine.Length -gt 600) { $_.CommandLine.Substring(0,600) + '...' } else { $_.CommandLine } } else { '' } }}
} catch {}

$installedAppVersion = $null
try {
  $pkgPath = Join-Path $env:LOCALAPPDATA "Programs\t3-code-desktop\resources\app.asar"
  if (Test-Path $pkgPath) { $installedAppVersion = "installed (asar present)" }
} catch {}
$sourcePkgVersion = $null
try {
  $desktopPkg = Get-Content -LiteralPath (Join-Path $repoRoot "apps\desktop\package.json") -Raw | ConvertFrom-Json
  $sourcePkgVersion = $desktopPkg.version
} catch {}

$nodeVersion = $null
try { $nodeVersion = (& node --version) 2>$null } catch {}
$pnpmVersion = $null
try { $pnpmVersion = (& pnpm --version) 2>$null } catch {}
$vpVersion = $null
try { $vpVersion = (& vp --version) 2>$null } catch {}
$osInfo = $null
try { $osInfo = (Get-CimInstance Win32_OperatingSystem).Caption + " " + (Get-CimInstance Win32_OperatingSystem).Version } catch {}

$metadata = [ordered]@{
  snapshotTime    = $snapshotTime.ToString("o")
  windowMinutes   = $Minutes
  cutoff          = $cutoff.ToString("o")
  hostname        = $env:COMPUTERNAME
  user            = $env:USERNAME
  os              = $osInfo
  nodeVersion     = $nodeVersion
  pnpmVersion     = $pnpmVersion
  vpVersion       = $vpVersion
  git             = $gitInfo
  sourceVersion   = $sourcePkgVersion
  installedApp    = $installedAppVersion
  processes       = $processes
  note            = $Note
}

$metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $workRoot "metadata.json")

if ($Note) {
  Set-Content -LiteralPath (Join-Path $workRoot "note.txt") -Value $Note
}

Write-Info "compressing"
if (Test-Path $Output) { Remove-Item -LiteralPath $Output -Force }
Compress-Archive -Path (Join-Path $workRoot "*") -DestinationPath $Output -CompressionLevel Optimal

$sizeKb = [Math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Done "snapshot ready: $Output  ($sizeKb KB)"

try { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
