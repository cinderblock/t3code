import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect, useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProviderUsageWindow,
  UsageHistorySample,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { observeResize } from "~/lib/observeResize";
import { usageEnvironment } from "../../state/quota";
import {
  formatPercent,
  seriesStyle,
  type SeriesStyle,
  windowHours,
  windowScopeName,
  windowShortLabel,
} from "./usagePresentation";

/** Until the first measure; afterwards the chart draws at its real width so labels keep their size. */
const DEFAULT_CHART_WIDTH = 640;
const CHART_HEIGHT = 132;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
/**
 * Without a reset time the domain is anchored on "now", which changes every
 * render. Rounding it keeps the history query key — and so the cached read —
 * stable for a while instead of re-fetching on every paint.
 */
const ANCHOR_BUCKET_MS = 5 * 60_000;

interface ChartDomain {
  readonly startMs: number;
  readonly endMs: number;
  readonly width: number;
}

function plotWidth(width: number): number {
  return Math.max(1, width - PAD_LEFT - PAD_RIGHT);
}

function timeToX(timeMs: number, domain: ChartDomain): number {
  const span = Math.max(1, domain.endMs - domain.startMs);
  const fraction = (timeMs - domain.startMs) / span;
  return PAD_LEFT + Math.max(0, Math.min(1, fraction)) * plotWidth(domain.width);
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
  instanceId: ProviderInstanceId;
  window: ServerProviderUsageWindow;
  style: SeriesStyle;
  since: string;
  domain: ChartDomain;
  hoverTimeMs: number | null;
}) {
  const { environmentId, instanceId, window, style, since, domain, hoverTimeMs } = props;
  const history = useAtomValue(
    usageEnvironment.usageHistory({
      environmentId,
      input: { instanceId, windowId: window.id, since },
    }),
  );
  const samples = Option.getOrNull(AsyncResult.value(history))?.samples ?? [];

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
    <g style={{ color: style.color }}>
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeDasharray={style.dashArray}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={3} fill="currentColor" />
      {/* Direct label at the line end — identity is never color-alone. */}
      <text
        x={lastX > domain.width - 110 ? lastX - 6 : lastX + 6}
        y={Math.max(lastY - 5, PAD_TOP + 8)}
        className="fill-muted-foreground text-3xs"
        textAnchor={lastX > domain.width - 110 ? "end" : "start"}
      >
        {windowShortLabel(window)} {formatPercent(last.percent)} used
      </text>
      {hoverSample !== null ? (
        <g>
          <circle
            cx={timeToX(Date.parse(hoverSample.capturedAt), domain)}
            cy={percentToY(hoverSample.percent)}
            r={3.5}
            fill="currentColor"
            stroke="var(--color-background)"
            strokeWidth={1.5}
          />
          <text
            x={timeToX(Date.parse(hoverSample.capturedAt), domain) + 6}
            y={percentToY(hoverSample.percent) - 5}
            className="fill-foreground text-3xs"
          >
            {formatPercent(hoverSample.percent)} used
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
  instanceId: ProviderInstanceId;
  windows: ReadonlyArray<ServerProviderUsageWindow>;
  /** The strip's clock, so the chart's "now" ticks with the meters. */
  nowMs: number;
  title: string;
  color: string;
}) {
  const { environmentId, instanceId, windows, nowMs, title, color } = props;
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_CHART_WIDTH);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ResizeObserver measures the SVG so its user units stay 1:1 with pixels
  useLayoutEffect(() => {
    if (!svg) return;
    const measure = () => {
      const measured = Math.round(svg.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    return observeResize(svg, measure);
  }, [svg]);

  const referenceWindow =
    windows.find((window) => windowScopeName(window) === null) ?? windows[0] ?? null;
  const hours = referenceWindow === null ? 5 : windowHours(referenceWindow);
  const resetMs =
    referenceWindow?.resetsAt !== undefined ? Date.parse(referenceWindow.resetsAt) : Number.NaN;
  const anchorMs = Number.isFinite(resetMs)
    ? resetMs
    : Math.floor(nowMs / ANCHOR_BUCKET_MS) * ANCHOR_BUCKET_MS;
  const endMs = Math.max(anchorMs, nowMs);
  const startMs = anchorMs - hours * 3600_000;
  const domain: ChartDomain = { startMs, endMs, width };
  const since = new Date(startMs).toISOString();

  const hoverTimeMs =
    hoverX === null ? null : startMs + ((hoverX - PAD_LEFT) / plotWidth(width)) * (endMs - startMs);
  const nowX = timeToX(nowMs, domain);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-muted-foreground text-xs">{title}</span>
        {/* Legend — always present for multi-series; chips + text labels. */}
        {windows.length > 1 ? (
          <span className="flex flex-wrap items-center gap-2">
            {windows.map((window, index) => {
              const style = seriesStyle(index, color);
              return (
                <span
                  key={window.id}
                  className="flex items-center gap-1 text-3xs text-muted-foreground"
                >
                  <svg aria-hidden width={12} height={4} style={{ color: style.color }}>
                    <line
                      x1={0}
                      x2={12}
                      y1={2}
                      y2={2}
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeDasharray={style.dashArray}
                    />
                  </svg>
                  {windowShortLabel(window)}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
      <svg
        ref={setSvg}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={`${title} usage history`}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width) * width;
          setHoverX(x >= PAD_LEFT && x <= width - PAD_RIGHT ? x : null);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* Recessive horizontal gridlines with y labels. */}
        {[0, 50, 100].map((percent) => (
          <g key={percent}>
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
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
              className="fill-muted-foreground/70 text-3xs"
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
          className="fill-muted-foreground/60 text-3xs"
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
              x={hoverX > width / 2 ? hoverX - 6 : hoverX + 6}
              y={CHART_HEIGHT - 6}
              textAnchor={hoverX > width / 2 ? "end" : "start"}
              className="fill-muted-foreground text-3xs"
            >
              {new Date(hoverTimeMs).toLocaleString(undefined, {
                ...(hours > 24 ? { weekday: "short" as const } : {}),
                hour: "2-digit",
                minute: "2-digit",
              })}
            </text>
          </g>
        ) : null}
        {windows.map((window, index) => (
          <SeriesLine
            key={window.id}
            environmentId={environmentId}
            instanceId={instanceId}
            window={window}
            style={seriesStyle(index, color)}
            since={since}
            domain={domain}
            hoverTimeMs={hoverTimeMs}
          />
        ))}
      </svg>
    </div>
  );
}
