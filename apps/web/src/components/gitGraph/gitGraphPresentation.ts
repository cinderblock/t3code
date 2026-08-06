import type { VcsGraphRef } from "@t3tools/contracts";

/**
 * Lane colours are identity, not data — they only need to be tellable apart.
 * Held at a mid lightness so the same value reads on both the light and dark
 * backgrounds without a per-theme palette, and spread across the hue circle so
 * adjacent lanes never collide.
 */
export const GIT_GRAPH_LANE_COLORS = [
  "oklch(0.65 0.16 250)",
  "oklch(0.65 0.16 140)",
  "oklch(0.65 0.16 25)",
  "oklch(0.65 0.16 290)",
  "oklch(0.65 0.16 70)",
  "oklch(0.65 0.16 190)",
  "oklch(0.65 0.16 330)",
  "oklch(0.65 0.16 105)",
] as const;

export function laneColor(column: number): string {
  // Lanes are unbounded but the palette is not; wrapping is fine because two
  // lanes far enough apart to share a colour are never adjacent.
  const index =
    ((column % GIT_GRAPH_LANE_COLORS.length) + GIT_GRAPH_LANE_COLORS.length) %
    GIT_GRAPH_LANE_COLORS.length;
  return GIT_GRAPH_LANE_COLORS[index]!;
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/** Ranks refs so the labels a reader scans for sit leftmost on the row. */
function refSortKey(ref: VcsGraphRef): number {
  if (ref.current) return 0;
  if (ref.kind === "local" && ref.isDefault) return 1;
  if (ref.kind === "local") return 2;
  if (ref.kind === "remote") return 3;
  return 4;
}

export function groupGraphRefsByOid(
  refs: ReadonlyArray<VcsGraphRef>,
): ReadonlyMap<string, ReadonlyArray<VcsGraphRef>> {
  const byOid = new Map<string, VcsGraphRef[]>();
  for (const ref of refs) {
    const existing = byOid.get(ref.oid);
    if (existing) {
      existing.push(ref);
    } else {
      byOid.set(ref.oid, [ref]);
    }
  }
  for (const [oid, group] of byOid) {
    byOid.set(
      oid,
      group.toSorted((left, right) => {
        const rank = refSortKey(left) - refSortKey(right);
        return rank !== 0 ? rank : left.name.localeCompare(right.name);
      }),
    );
  }
  return byOid;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Compact commit age for a dense list. Takes `nowMs` rather than reading the
 * clock so it stays pure and testable.
 */
export function formatCommitAge(commitMs: number, nowMs: number): string {
  const elapsed = nowMs - commitMs;
  // A commit dated in the future means clock skew between the repo and this
  // machine, not a real duration; showing "in 3 hours" would just look broken.
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  if (elapsed < YEAR_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;
  return `${Math.floor(elapsed / YEAR_MS)}y`;
}
