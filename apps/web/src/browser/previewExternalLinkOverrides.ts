/**
 * Per-tab overrides for "where do external links open".
 *
 * The global preference lives in client settings
 * (`previewExternalLinkBehavior`). This store holds the deliberate per-tab
 * exceptions a user makes from the preview's three-dot menu — "just this tab,
 * keep links in the panel" while following a docs trail, say.
 *
 * Deliberately not persisted: an override is a scoped exception for the tab in
 * front of you, and one silently outliving its session would be worse than
 * re-applying it. Entries are dropped when the tab closes.
 */
import type { PreviewExternalLinkBehavior } from "@t3tools/contracts";
import { create } from "zustand";

/** `null` (or an absent entry) means "follow the global setting". */
export type PreviewExternalLinkOverride = PreviewExternalLinkBehavior | null;

interface PreviewExternalLinkOverrideState {
  readonly byTabId: Readonly<Record<string, PreviewExternalLinkBehavior>>;
  readonly setOverride: (tabId: string, override: PreviewExternalLinkOverride) => void;
  readonly clearTab: (tabId: string) => void;
}

export const usePreviewExternalLinkOverrideStore = create<PreviewExternalLinkOverrideState>(
  (set) => ({
    byTabId: {},
    setOverride: (tabId, override) =>
      set((state) => {
        if ((state.byTabId[tabId] ?? null) === override) return state;
        const next = { ...state.byTabId };
        if (override === null) delete next[tabId];
        else next[tabId] = override;
        return { byTabId: next };
      }),
    clearTab: (tabId) =>
      set((state) => {
        if (!(tabId in state.byTabId)) return state;
        const next = { ...state.byTabId };
        delete next[tabId];
        return { byTabId: next };
      }),
  }),
);

/** Subscribe to one tab's override without re-rendering on unrelated tabs. */
export function usePreviewExternalLinkOverride(tabId: string | null): PreviewExternalLinkOverride {
  return usePreviewExternalLinkOverrideStore((state) =>
    tabId === null ? null : (state.byTabId[tabId] ?? null),
  );
}

/**
 * The behavior actually in force for a tab: its override if it has one, else
 * the global setting.
 */
export function resolvePreviewExternalLinkBehavior(
  override: PreviewExternalLinkOverride,
  globalBehavior: PreviewExternalLinkBehavior,
): PreviewExternalLinkBehavior {
  return override ?? globalBehavior;
}
