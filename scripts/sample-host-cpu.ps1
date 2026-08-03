<#
.SYNOPSIS
  Samples per-process CPU on the host during T3 Code startup.

.DESCRIPTION
  Answers one question: during the startup disconnect storm, WHO is burning the
  machine's CPU?

  The backend's own event-loop monitor already reports that `systemCpuPct` sits
  at 98-100% while the backend's `selfCpuPct` is only 28-54% -- the backend is
  being starved, not burning CPU itself. That says the culprit is another
  process, and nothing so far has measured which one.

  The standing suspect is Windows Defender. T3 Code spawns ~2,200 git processes
  in the first 90s, real-time protection and behaviour monitoring are on, and
  this repo has no Defender exclusion. Every one of those spawns is inspected.
  If that is the amplifier, MsMpEng.exe will be eating cores for exactly the
  window the drops happen in, and will fall away when they stop.

  Deliberately a separate process from the backend: the whole point is to
  measure the backend while it is starved, so the sampler must not compete for
  the same event loop, and must keep running if the backend stalls.

  Writes one JSON line per sample. Read it alongside diagnostics.ndjson --
  both carry epoch millis, so they line up directly.

.NOTES
  Read-only. Samples process counters; changes nothing.
#>
[CmdletBinding()]
param(
  # Where to append samples (NDJSON).
  [Parameter(Mandatory = $true)][string]$OutFile,
  # Total sampling window. The storm has always ended by ~162s; 240 covers it.
  [int]$Seconds = 240,
  [double]$IntervalSeconds = 1.0
)

$ErrorActionPreference = 'Stop'

# Process CPU is a monotonically increasing total, so a sample is only meaningful
# as a delta against the previous one. Keyed by name; values are total CPU seconds.
$previous = @{}
$cores = [Environment]::ProcessorCount

# MsMpEng is the Defender engine (the "Antimalware Service Executable"). System
# is included because minifilter work can land in kernel context rather than in
# MsMpEng itself, so attributing to MsMpEng alone could understate Defender.
#
# The desktop app AND its backend both run as `electron` (the backend is a child
# launched from node_modules/electron), so that one name covers both; the
# backend's own share is already reported as `selfCpuPct` in diagnostics.ndjson.
#
# Caveat on `gitCount`: spawns last ~9ms, so a 1s sample almost never catches one
# and this will read ~0 even while thousands are being spawned. It indicates
# sustained concurrency, NOT spawn rate -- do not read a low value as "no flood".
$watch = @('MsMpEng', 'System', 'node', 'git', 'electron')

function Get-CpuByName {
  $totals = @{}
  $counts = @{}
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    $name = $p.ProcessName
    if ($watch -notcontains $name) { continue }
    $cpu = 0.0
    # .CPU throws for protected processes even when elevated; a missing sample is
    # better than a dead sampler.
    try { if ($null -ne $p.CPU) { $cpu = [double]$p.CPU } } catch { }
    $totals[$name] = [double]($totals[$name]) + $cpu
    $counts[$name] = [int]($counts[$name]) + 1
  }
  return @{ Totals = $totals; Counts = $counts }
}

$deadline = (Get-Date).AddSeconds($Seconds)
$startedAt = Get-Date

while ((Get-Date) -lt $deadline) {
  $tickStart = Get-Date
  $snap = Get-CpuByName
  $record = [ordered]@{
    tsEpochMs      = [long][Math]::Round(([DateTimeOffset](Get-Date)).ToUnixTimeMilliseconds())
    kind           = 'host-cpu'
    sinceStartMs   = [long][Math]::Round(((Get-Date) - $startedAt).TotalMilliseconds)
    cpuCount       = $cores
  }

  foreach ($name in $watch) {
    $total = [double]($snap.Totals[$name])
    $count = [int]($snap.Counts[$name])
    $key = $name.Replace(' ', '')
    if ($previous.ContainsKey($name)) {
      $deltaSec = $total - [double]$previous[$name]
      if ($deltaSec -lt 0) { $deltaSec = 0 }  # a process exited and took its total with it
      # Percent of the WHOLE machine, so these are directly comparable to each
      # other and sum toward 100 -- not percent-of-one-core, which reads as >100.
      $record["${key}Pct"] = [Math]::Round(100.0 * $deltaSec / ($IntervalSeconds * $cores), 1)
    }
    $record["${key}Count"] = $count
    $previous[$name] = $total
  }

  try {
    Add-Content -Path $OutFile -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
  } catch {
    # Never let the sampler die on a transient file lock.
  }

  $elapsed = ((Get-Date) - $tickStart).TotalSeconds
  $sleep = $IntervalSeconds - $elapsed
  if ($sleep -gt 0) { Start-Sleep -Seconds $sleep }
}
