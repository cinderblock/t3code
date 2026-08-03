import { useEffect, useRef, useState } from "react";

/**
 * Asymmetric debounce for a boolean: slow to raise, immediate to clear.
 *
 * Fork addition, for the composer's "environment unavailable" gate.
 *
 * That gate is `connectionPhase !== "connected"`, which is correct but twitchy. The connection
 * supervisor's retry ladder starts at a 1s delay, so a single brief drop disables the send and
 * queue controls and re-enables them a moment later. During a reconnect storm the composer
 * flickers in and out of usability, which is worse than either steady state: you cannot tell
 * whether it is safe to type, and a click can land on a control that just went disabled.
 *
 * Raising slowly hides reconnects short enough that the user would never have noticed them.
 * Clearing immediately means recovery is never delayed — the moment the connection is back the
 * UI is usable again, which is the half of the behaviour that actually matters.
 *
 * `delayMs` is measured from the most recent rising edge; a value that flaps true/false/true
 * restarts the timer rather than accumulating, so only a *sustained* outage trips the flag.
 */
export function useSettledFlag(value: boolean, delayMs: number): boolean {
  const [settled, setSettled] = useState(value);
  // Kept in a ref so the effect below does not need `settled` as a dependency, which would
  // restart the timer every time it fires.
  const settledRef = useRef(settled);
  settledRef.current = settled;

  useEffect(() => {
    if (!value) {
      setSettled(false);
      return;
    }
    if (settledRef.current) {
      return;
    }
    const timer = setTimeout(() => setSettled(true), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
