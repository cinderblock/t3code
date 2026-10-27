import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  isUsageResetSnoozePreset,
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
  type SnoozeUsageResets,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export { snoozeWakeLabel, type SnoozePreset };

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
  resets?: SnoozeUsageResets,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now, resets).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    const showWeekday =
      preset.id === "next-week" ||
      (isUsageResetSnoozePreset(preset.id) && wake.toDateString() !== now.toDateString());
    return {
      ...preset,
      whenLabel: showWeekday
        ? `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
        : time,
    };
  });
}
