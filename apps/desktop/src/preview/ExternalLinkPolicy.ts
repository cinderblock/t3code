/**
 * Decides whether a page-initiated navigation inside the preview panel should
 * leave for the OS default browser instead of loading in the panel.
 *
 * Kept pure and free of Electron imports so the policy can be tested directly.
 * The renderer owns the preference (a global client setting plus an optional
 * per-tab override) and pushes the resolved value down; this module only
 * answers "given that value, where does this navigation go?".
 */
import type { PreviewExternalLinkBehavior } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { parseSafeExternalUrl } from "../electron/ElectronShell.ts";

export interface ExternalNavigationInput {
  readonly behavior: PreviewExternalLinkBehavior;
  /** The URL the tab is currently showing. May be "" or "about:blank". */
  readonly currentUrl: string;
  /** The URL the page wants to navigate to. */
  readonly navigationUrl: string;
}

/**
 * `Some(href)` when the navigation should be handed to the system browser and
 * cancelled in-panel; `None` when it should proceed normally.
 *
 * Returns `None` — i.e. stays in-panel — in each of these cases:
 *
 * - the behavior is `in-app`;
 * - the target is not `http(s)` (`mailto:`, `vscode:`, … keep whatever
 *   handling they had, since `shell.openExternal` must not be handed
 *   arbitrary schemes from a guest page);
 * - the tab has no http(s) page loaded yet, so there is no origin to leave.
 *   A fresh tab sits on `""`/`about:blank`, and bouncing its *first*
 *   navigation to the system browser would leave the panel permanently empty;
 * - the origin is unchanged.
 */
export function externalNavigationTarget(input: ExternalNavigationInput): Option.Option<string> {
  if (input.behavior !== "system-browser") return Option.none();

  const target = parseSafeExternalUrl(input.navigationUrl);
  if (Option.isNone(target)) return Option.none();

  const current = parseSafeExternalUrl(input.currentUrl);
  if (Option.isNone(current)) return Option.none();

  return new URL(current.value).origin === new URL(target.value).origin ? Option.none() : target;
}
