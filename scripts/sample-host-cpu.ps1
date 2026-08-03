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
# Per-PID CPU totals from the previous tick, for whole-machine attribution.
$prevAll = @{}
$prevIdle = $null
$prevStamp = $null
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
  $all = @{}
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    $name = $p.ProcessName
    $cpu = 0.0
    # .CPU throws for protected processes even when elevated; a missing sample is
    # better than a dead sampler.
    try { if ($null -ne $p.CPU) { $cpu = [double]$p.CPU } } catch { }
    # Per-PID, so a process that exits and one that starts are not conflated into
    # a single name total (which would produce bogus negative deltas).
    $all["$name#$($p.Id)"] = $cpu
    if ($watch -notcontains $name) { continue }
    $totals[$name] = [double]($totals[$name]) + $cpu
    $counts[$name] = [int]($counts[$name]) + 1
  }
  return @{ Totals = $totals; Counts = $counts; All = $all }
}

$deadline = (Get-Date).AddSeconds($Seconds)
$startedAt = Get-Date

while ((Get-Date) -lt $deadline) {
  $tickStart = Get-Date
  $rawIdle = $null; $rawStamp = $null
  try {
    $perf = Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop
    $rawIdle = [double]$perf.PercentIdleTime
    $rawStamp = [double]$perf.Timestamp_Sys100NS
  } catch { }
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

  # --- who is using the REST of the machine? -----------------------------
  # The first run of this sampler found 69-87% of a 12-core box unaccounted for
  # by the named watch list, which makes the watch list the wrong tool: it can
  # only ever confirm suspects, never identify one. So attribute every process,
  # report the biggest movers, and publish the shortfall explicitly.
  #
  # The shortfall is the interesting number. `Get-Process` samples
  # instantaneously, so a git.exe that lives ~9ms is almost never observed --
  # meaning the CPU burned by thousands of short-lived spawns CANNOT appear in
  # any per-process total here. A large `unaccountedPct` alongside a small
  # `topProcs` is therefore positive evidence for the spawn flood, not a gap in
  # the measurement. A large shortfall explained by some process in `topProcs`
  # means the opposite: a long-lived hog we simply had not thought to watch.
  $hadPrev = $prevAll.Count -gt 0
  $sampledPct = 0.0
  $movers = @()
  foreach ($key in $snap.All.Keys) {
    # A process not present last tick is SKIPPED, not counted from zero. Its
    # total is lifetime CPU, so counting it as one interval's delta would
    # massively overstate the sample (the first tick otherwise reports
    # ~1,000,000%, and later ticks can exceed the machine total and produce a
    # negative shortfall). Skipping means CPU burned by processes that come and
    # go inside one interval lands in `unaccountedPct` -- which is precisely the
    # quantity being measured here.
    if (-not $prevAll.ContainsKey($key)) { continue }
    $delta = [double]$snap.All[$key] - [double]$prevAll[$key]
    if ($delta -le 0) { continue }
    $pct = 100.0 * $delta / ($IntervalSeconds * $cores)
    $sampledPct += $pct
    if ($pct -ge 1.0) {
      $movers += [pscustomobject]@{ Name = $key.Split('#')[0]; Pct = [Math]::Round($pct, 1) }
    }
  }
  $prevAll = $snap.All

  if ($hadPrev) {
    $record['sampledTotalPct'] = [Math]::Round($sampledPct, 1)
    $top = @($movers) | Sort-Object -Property Pct -Descending | Select-Object -First 8
    $record['topProcs'] = @($top | ForEach-Object { "$($_.Name):$($_.Pct)" })
    # Machine-wide ground truth, measured over the SAME interval as the
    # per-process deltas above. Get-Counter was tried first and is wrong for this:
    # it samples an instant, so it routinely disagreed with an interval sum and
    # produced negative shortfalls. Raw idle-time deltas mirror exactly how the
    # backend derives systemCpuPct from os.cpus(), so the two are comparable.
    if ($null -ne $prevIdle) {
      $dIdle = [double]$rawIdle - $prevIdle
      $dTime = [double]$rawStamp - $prevStamp
      if ($dTime -gt 0) {
        # NOT divided by $cores: the _Total instance's PercentIdleTime is already
        # averaged across processors, not summed. Dividing again reports a fully
        # idle 12-core box as 100*(1 - 1/12) = 92% busy.
        $busy = 100.0 * (1.0 - ($dIdle / $dTime))
        if ($busy -lt 0) { $busy = 0 }
        $record['machineCpuPct'] = [Math]::Round($busy, 1)
        $record['unaccountedPct'] = [Math]::Round($busy - $sampledPct, 1)
      }
    }
  }

  # Updated only AFTER the block above consumes it. Rolling it forward earlier
  # makes every delta zero, which silently drops machineCpuPct entirely.
  if ($null -ne $rawIdle) { $prevIdle = $rawIdle; $prevStamp = $rawStamp }

  try {
    Add-Content -Path $OutFile -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
  } catch {
    # Never let the sampler die on a transient file lock.
  }

  $elapsed = ((Get-Date) - $tickStart).TotalSeconds
  $sleep = $IntervalSeconds - $elapsed
  if ($sleep -gt 0) { Start-Sleep -Seconds $sleep }
}
