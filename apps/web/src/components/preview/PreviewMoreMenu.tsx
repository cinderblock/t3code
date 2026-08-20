"use client";

import type { DesktopPreviewColorScheme, PreviewExternalLinkBehavior } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import type { PreviewExternalLinkOverride } from "~/browser/previewExternalLinkOverrides";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The override radio group uses "default" as a real value rather than an
 * absent selection, so the menu always shows which of the three states the
 * tab is in — including "no override, following the setting".
 */
const EXTERNAL_LINK_OVERRIDE_DEFAULT = "default";

const EXTERNAL_LINK_BEHAVIOR_LABELS: Record<PreviewExternalLinkBehavior, string> = {
  "system-browser": "Open in system browser",
  "in-app": "Open in preview",
};

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Emulated `prefers-color-scheme` for the guest page. */
  colorScheme: DesktopPreviewColorScheme;
  /** This tab's external-link exception, or `null` to follow the setting. */
  externalLinkOverride: PreviewExternalLinkOverride;
  /** The global setting, shown so "Use default" says what it resolves to. */
  externalLinkDefault: PreviewExternalLinkBehavior;
  /** Set or clear this tab's exception. `null` clears it. */
  onExternalLinkOverrideChange: (next: PreviewExternalLinkBehavior | null) => void;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Toggles the optional native always-on-top preview window. */
  onNativePictureInPicture: () => void;
}

/**
 * Three-dot menu in the chrome row. Wires Hard reload, DevTools, zoom
 * controls, and storage-clearing actions. Only mounted by `PreviewView`
 * when the desktop bridge is present, so we can call it unconditionally.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  colorScheme,
  externalLinkOverride,
  externalLinkDefault,
  onExternalLinkOverrideChange,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  onNativePictureInPicture,
}: Props) {
  if (!previewBridge) return null;
  const bridge = previewBridge;
  const tabDisabled = !tabId || !hasWebContents;
  const callTab = (op: (tabId: string) => Promise<void>) => () => {
    if (!tabId) return;
    void op(tabId).catch(() => undefined);
  };

  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={callTab(bridge.hardReload)} disabled={tabDisabled}>
          Hard reload
        </MenuItem>
        <MenuItem onClick={callTab(bridge.openDevTools)} disabled={tabDisabled}>
          Open DevTools
        </MenuItem>
        <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
          {nativePictureInPicture
            ? "Close separate preview window"
            : "Open separate preview window"}
        </MenuItem>
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={!tabId}>External links</MenuSubTrigger>
          <MenuSubPopup className="min-w-56">
            <MenuRadioGroup
              value={externalLinkOverride ?? EXTERNAL_LINK_OVERRIDE_DEFAULT}
              onValueChange={(value) => {
                onExternalLinkOverrideChange(
                  value === EXTERNAL_LINK_OVERRIDE_DEFAULT
                    ? null
                    : (value as PreviewExternalLinkBehavior),
                );
              }}
            >
              <MenuRadioItem value={EXTERNAL_LINK_OVERRIDE_DEFAULT}>
                {`Use default (${EXTERNAL_LINK_BEHAVIOR_LABELS[externalLinkDefault].toLowerCase()})`}
              </MenuRadioItem>
              <MenuRadioItem value="system-browser">
                {EXTERNAL_LINK_BEHAVIOR_LABELS["system-browser"]}
              </MenuRadioItem>
              <MenuRadioItem value="in-app">
                {EXTERNAL_LINK_BEHAVIOR_LABELS["in-app"]}
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuSeparator />
            {/*
              Spelled out rather than hidden behind a hover tooltip: the scope
              of the rule is the whole point, and it is easy to read this as
              "all links" otherwise.
            */}
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Applies to links that leave the current site. Links within the site, the address bar,
              and agent navigation always stay in the preview.
            </p>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger disabled={tabDisabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup className="min-w-32">
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => {
                if (!tabId) return;
                void bridge
                  .setColorScheme(tabId, value as DesktopPreviewColorScheme)
                  .catch(() => undefined);
              }}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={tabDisabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.zoomOut)}
              aria-label="Zoom out"
              disabled={tabDisabled}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.zoomIn)}
              aria-label="Zoom in"
              disabled={tabDisabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={callTab(bridge.resetZoom)}
              aria-label="Reset zoom"
              disabled={tabDisabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void bridge.clearCookies().catch(() => undefined)}>
          Clear cookies
        </MenuItem>
        <MenuItem onClick={() => void bridge.clearCache().catch(() => undefined)}>
          Clear cache
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
