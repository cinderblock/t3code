import sys, json
from collections import defaultdict

threshold = float(sys.argv[1]) if len(sys.argv) > 1 else 5000.0
counts = defaultdict(int)
tot = defaultdict(float)
mx = defaultdict(float)
minNano = None
maxNano = None
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    d = o.get("durationMs")
    if d is None:
        continue
    st = o.get("startTimeUnixNano")
    if st:
        st = int(st)
        minNano = st if minNano is None else min(minNano, st)
        maxNano = st if maxNano is None else max(maxNano, st)
    if d >= threshold:
        nm = o.get("name", "?")
        counts[nm] += 1
        tot[nm] += d
        mx[nm] = max(mx[nm], d)
        n += 1

print("threshold ms:", threshold)
if minNano and maxNano:
    span_s = (maxNano - minNano) / 1e9
    print("time window (s):", round(span_s, 1), "hours:", round(span_s/3600, 2))
print("total spans >= threshold:", n)
print("%-45s %6s %10s %12s" % ("name", "count", "maxMs", "sumMs"))
for nm in sorted(counts, key=lambda k: -tot[k]):
    print("%-45s %6d %10.0f %12.0f" % (nm, counts[nm], mx[nm], tot[nm]))
