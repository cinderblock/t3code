#!/usr/bin/env python3
"""Summarise an Effect trace NDJSON into a latency/throughput profile.

Complements slow-spans.py: that one lists individual slow spans, this one
aggregates by span name so you can see which operation dominates a window and
whether the latency is real work or event-loop queueing.

    python3 scripts/span-profile.py < ~/.t3/userdata/logs/server.trace.ndjson
    tail -c 6000000 server.trace.ndjson | python3 scripts/span-profile.py --top 25
"""

from __future__ import annotations

import argparse
import collections
import json
import sys


def load(stream):
    rows = []
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue  # partial first line from a tail -c cut
        if row.get("type") == "effect-span":
            rows.append(row)
    return rows


def percentile(sorted_values, q):
    if not sorted_values:
        return 0.0
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * q))]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", type=int, default=20, help="rows to print per table")
    args = parser.parse_args()

    rows = load(sys.stdin)
    if not rows:
        print("no effect-span rows found on stdin", file=sys.stderr)
        return 1

    starts = [int(r["startTimeUnixNano"]) for r in rows]
    window_s = (max(starts) - min(starts)) / 1e9 or 1.0

    durations = collections.defaultdict(list)
    for row in rows:
        durations[row["name"]].append(row.get("durationMs") or 0.0)

    print(f"spans={len(rows)}  window={window_s:.1f}s ({window_s / 60:.1f} min)\n")

    print("=== by rate (calls/sec) ===")
    print(f"{'span':<46}{'n':>7}{'/sec':>9}{'avg ms':>10}{'p50':>9}{'p95':>10}{'max':>10}")
    ranked = sorted(durations.items(), key=lambda kv: len(kv[1]), reverse=True)
    for name, values in ranked[: args.top]:
        values.sort()
        print(
            f"{name:<46}{len(values):>7}{len(values) / window_s:>9.2f}"
            f"{sum(values) / len(values):>10.1f}{percentile(values, 0.5):>9.1f}"
            f"{percentile(values, 0.95):>10.1f}{values[-1]:>10.0f}"
        )

    print("\n=== by total wall time (sum ms) ===")
    print(f"{'span':<46}{'total ms':>12}{'n':>7}{'avg ms':>10}")
    by_total = sorted(durations.items(), key=lambda kv: sum(kv[1]), reverse=True)
    for name, values in by_total[: args.top]:
        print(f"{name:<46}{sum(values):>12.0f}{len(values):>7}{sum(values) / len(values):>10.1f}")

    print("\n=== queueing signal (p50 fast but p95 slow => event loop starvation) ===")
    print(f"{'span':<46}{'p50':>9}{'p95':>10}{'ratio':>9}{'n':>7}")
    flagged = []
    for name, values in durations.items():
        if len(values) < 20:
            continue
        values.sort()
        p50, p95 = percentile(values, 0.5), percentile(values, 0.95)
        if p50 > 0 and p95 / p50 >= 5:
            flagged.append((p95 / p50, name, p50, p95, len(values)))
    for ratio, name, p50, p95, n in sorted(flagged, reverse=True)[: args.top]:
        print(f"{name:<46}{p50:>9.1f}{p95:>10.1f}{ratio:>9.1f}x{n:>6}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
