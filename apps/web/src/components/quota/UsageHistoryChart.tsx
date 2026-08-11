import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, UsageHistorySample, UsageWindow } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { cn } from "~/lib/utils";
import { usageEnvironment } from "../../state/quota";
import { formatPercent, seriesSlotClassForWindow, windowShortLabel } from "./usagePresentation";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 132;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

interface ChartDomain {
  readonly startMs: number;
  readonly endMs: number;
}

function timeToX(timeMs: number, domain: ChartDomain): number {
  const span = Math.max(1, domain.endMs - domain.startMs);
  const fraction = (timeMs - domain.startMs) / span;
  return PAD_LEFT + Math.max(0, Math.min(1, fraction)) * PLOT_WIDTH;
}

function percentToY(percent: number): number {
  const clamped = Math.max(0, Math.min(110, percent));
  return PAD_TOP + PLOT_HEIGHT - (clamped / 110) * PLOT_HEIGHT;
}

function nearestSample(
  samples: ReadonlyArray<UsageHistorySample>,
  timeMs: number,
): UsageHistorySample | null {
  let nearest: UsageHistorySample | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const sampleMs = Date.parse(sample.capturedAt);
    const delta = Math.abs(sampleMs - timeMs);
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = sample;
    }
  }
  return nearest;
}

/**
 * One series: fetches its own history so the hook count stays constant per
 * component regardless of how many windows the group carries.
 */
function SeriesLine(props: {
  environmentId: EnvironmentId;
  accountKey: string;
  window: UsageWindow;
  since: string;
  domain: ChartDomain;
  hoverTimeMs: number | null;
}) {
  const { environmentId, accountKey, window, since, domain, hoverTimeMs } = props;
  const history = useAtomValue(
    usageEnvironment.usageHistory({
      environmentId,
      input: { accountKey, windowId: window.id, since },
    }),
  );
  const samples = Option.getOrNull(AsyncResult.value(history))?.samples ?? [];
  const colorClass = seriesSlotClassForWindow(window);

  const points = samples
    .map((sample) => {
      const timeMs = Date.parse(sample.capturedAt);
      if (!Number.isFinite(timeMs)) return null;
      return `${timeToX(timeMs, domain).toFixed(1)},${percentToY(sample.percent).toFixed(1)}`;
    })
    .filter((point): point is string => point !== null);
  if (points.length === 0) return null;

  const last = samples[samples.length - 1]!;
  const lastX = timeToX(Date.parse(last.capturedAt), domain);
  const lastY = percentToY(last.percent);
  const hoverSample = hoverTimeMs === null ? null : nearestSample(samples, hoverTimeMs);

  return (
    <g className={colorClass}>
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--series-color)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={3} fill="var(--series-color)" />
      {/* Direct label at the line end — identity is never color-alone. */}
      <text
        x={lastX > CHART_WIDTH - 90 ? lastX - 6 : lastX + 6}
        y={Math.max(lastY - 5, PAD_TOP + 8)}
        className="fill-muted-foreground"
        fontSize={9}
        textAnchor={lastX > CHART_WIDTH - 90 ? "end" : "start"}
      >
        {windowShortLabel(window)} {formatPercent(last.percent)}
      </text>
      {hoverSample !== null ? (
        <g>
          <circle
            cx={timeToX(Date.parse(hoverSample.capturedAt), domain)}
            cy={percentToY(hoverSample.percent)}
            r={3.5}
            fill="var(--series-color)"
            stroke="var(--color-background)"
            strokeWidth={1.5}
          />
          <text
            x={timeToX(Date.parse(hoverSample.capturedAt), domain) + 6}
            y={percentToY(hoverSample.percent) - 5}
            fontSize={9}
            className="fill-foreground"
          >
            {formatPercent(hoverSample.percent)}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * Usage-over-time chart for one group of related windows (e.g. all weekly
 * windows on one shared 7-day axis). Hand-rolled SVG per repo convention.
 */
export function UsageHistoryChart(props: {
  environmentId: EnvironmentId;
  accountKey: string;
  windows: ReadonlyArray<UsageWindow>;
  title: string;
}) {
  const { environmentId, accountKey, windows, title } = props;
  const [hoverX, setHoverX] = useState<number | null>(null);

  const referenceWindow =
    windows.find((window) => window.scope.kind === "all") ?? windows[0] ?? null;
  const windowHours = referenceWindow?.windowHours ?? 5;
  const resetMs =
    referenceWindow?.resetsAt != null ? Date.parse(referenceWindow.resetsAt) : Number.NaN;
  const nowMs = Date.now();
  const endMs = Number.isFinite(resetMs) ? Math.max(resetMs, nowMs) : nowMs;
  const startMs = Number.isFinite(resetMs)
    ? resetMs - windowHours * 3600_000
    : nowMs - windowHours * 3600_000;
  const domain: ChartDomain = { startMs, endMs };
  const since = new Date(startMs).toISOString();

  const hoverTimeMs =
    hoverX === null ? null : startMs + ((hoverX - PAD_LEFT) / PLOT_WIDTH) * (endMs - startMs);
  const nowX = timeToX(nowMs, domain);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-muted-foreground text-xs">{title}</span>
        {/* Legend — always present for multi-series; chips + text labels. */}
        {windows.length > 1 ? (
          <span className="flex flex-wrap items-center gap-2">
            {windows.map((window) => (
              <span
                key={window.id}
                className={cn(
                  "flex items-center gap-1 text-[10px] text-muted-foreground",
                  seriesSlotClassForWindow(window),
                )}
              >
                <span className="inline-block size-2 rounded-[2px] bg-[var(--series-color)]" />
                {windowShortLabel(window)}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`${title} usage history`}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
          setHoverX(x >= PAD_LEFT && x <= CHART_WIDTH - PAD_RIGHT ? x : null);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* Recessive horizontal gridlines with y labels. */}
        {[0, 50, 100].map((percent) => (
          <g key={percent}>
            <line
              x1={PAD_LEFT}
              x2={CHART_WIDTH - PAD_RIGHT}
              y1={percentToY(percent)}
              y2={percentToY(percent)}
              stroke="currentColor"
              className="text-border"
              strokeWidth={percent === 100 ? 1 : 0.5}
              strokeDasharray={percent === 100 ? "4 3" : undefined}
            />
            <text
              x={PAD_LEFT - 4}
              y={percentToY(percent) + 3}
              textAnchor="end"
              fontSize={9}
              className="fill-muted-foreground/70"
            >
              {percent}
            </text>
          </g>
        ))}
        {/* Even-pace reference: 0% at window start → 100% at reset. */}
        <line
          x1={timeToX(startMs, domain)}
          y1={percentToY(0)}
          x2={timeToX(Number.isFinite(resetMs) ? resetMs : endMs, domain)}
          y2={percentToY(100)}
          stroke="currentColor"
          className="text-muted-foreground/40"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
        {/* Now marker. */}
        <line
          x1={nowX}
          x2={nowX}
          y1={PAD_TOP}
          y2={PAD_TOP + PLOT_HEIGHT}
          stroke="currentColor"
          className="text-muted-foreground/30"
          strokeWidth={1}
        />
        <text
          x={nowX}
          y={CHART_HEIGHT - 6}
          textAnchor="middle"
          fontSize={9}
          className="fill-muted-foreground/60"
        >
          now
        </text>
        {hoverTimeMs !== null && hoverX !== null ? (
          <g>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PAD_TOP}
              y2={PAD_TOP + PLOT_HEIGHT}
              stroke="currentColor"
              className="text-muted-foreground/50"
              strokeWidth={1}
            />
            <text
              x={hoverX > CHART_WIDTH / 2 ? hoverX - 6 : hoverX + 6}
              y={CHART_HEIGHT - 6}
              textAnchor={hoverX > CHART_WIDTH / 2 ? "end" : "start"}
              fontSize={9}
              className="fill-muted-foreground"
            >
              {new Date(hoverTimeMs).toLocaleString(undefined, {
                ...(windowHours > 24 ? { weekday: "short" as const } : {}),
                hour: "2-digit",
                minute: "2-digit",
              })}
            </text>
          </g>
        ) : null}
        {windows.map((window) => (
          <SeriesLine
            key={window.id}
            environmentId={environmentId}
            accountKey={accountKey}
            window={window}
            since={since}
            domain={domain}
            hoverTimeMs={hoverTimeMs}
          />
        ))}
      </svg>
    </div>
  );
}
