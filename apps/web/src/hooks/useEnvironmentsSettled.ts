import { useEffect, useState } from "react";

import { useAllEnvironmentShellsBootstrapped } from "../state/entities";

/**
 * How long the UI will wait for the slowest environment before rendering without it.
 *
 * Long enough that a healthy local backend always wins the race — its shell snapshot arrives
 * in well under a second — and short enough that a wedged environment is a brief pause rather
 * than a dead screen.
 */
export const ENVIRONMENT_SETTLE_GRACE_MS = 2_500;

/**
 * Whether a surface should keep waiting rather than render what it already knows.
 *
 * `useAllEnvironmentShellsBootstrapped` demands that *every* catalogued environment either
 * produce a shell snapshot or settle into a disconnected phase. A remote that connects but
 * never delivers a snapshot — an outdated or wedged backend answers the socket, so it is
 * neither disconnected nor bootstrapped — satisfies neither side and pins that atom to
 * `false` for the whole session. Callers gate rendering on it, so one unreachable environment
 * blanks surfaces that only ever needed the local one.
 *
 * Waiting is still right for the moment before a healthy environment reports, which is what
 * the gate exists for: a landing that renders before its projects load picks the wrong "most
 * recent" project and navigates away from under the reader. So wait, but only for `graceMs`.
 * Past the deadline, render with whatever environments did report — a down environment
 * contributes no projects whether or not we keep waiting for it.
 */
export function shouldWaitForEnvironments(input: {
  readonly bootstrapped: boolean;
  readonly elapsedMs: number;
  readonly graceMs: number;
}): boolean {
  if (input.bootstrapped) {
    return false;
  }
  return input.elapsedMs < input.graceMs;
}

/** Whether the shell has heard enough from its environments to render. */
export function useEnvironmentsSettled(graceMs: number = ENVIRONMENT_SETTLE_GRACE_MS): boolean {
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    if (bootstrapped || graceElapsed) {
      return;
    }
    const timer = setTimeout(() => setGraceElapsed(true), graceMs);
    return () => clearTimeout(timer);
  }, [bootstrapped, graceElapsed, graceMs]);

  return !shouldWaitForEnvironments({
    bootstrapped,
    elapsedMs: graceElapsed ? graceMs : 0,
    graceMs,
  });
}
