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
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

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

/** The tab's external-link policy. Only the desktop shell enforces it, so other hosts omit it. */
export interface PreviewMoreMenuExternalLinks {
  /** This tab's exception, or `null` to follow the setting. */
  readonly override: PreviewExternalLinkOverride;
  /** The global setting, shown so "Use default" says what it resolves to. */
  readonly defaultBehavior: PreviewExternalLinkBehavior;
  /** Set or clear this tab's exception. `null` clears it. */
  readonly onOverrideChange: (next: PreviewExternalLinkBehavior | null) => void;
}

export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  readonly openDevTools?: () => void;
  readonly toggleNativePictureInPicture?: () => void;
}

interface Props {
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  deviceToolbarVisible: boolean;
  onToggleDeviceToolbar: () => void;
  nativePictureInPicture: boolean;
  profileName: string | undefined;
  externalLinks?: PreviewMoreMenuExternalLinks;
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = () => (
  <Tooltip>
    <TooltipTrigger
      render={
        <MenuTrigger
          render={<Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />}
        />
      }
    >
      <MoreVertical />
    </TooltipTrigger>
    <TooltipPopup>More</TooltipPopup>
  </Tooltip>
);

export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  externalLinks,
  move,
}: Props) {
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu>
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          Hard reload
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            Open DevTools
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? "Close separate preview window"
              : "Open separate preview window"}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        {externalLinks ? (
          <MenuSub>
            <MenuSubTrigger disabled={disabled}>External links</MenuSubTrigger>
            <MenuSubPopup className="min-w-56">
              <MenuRadioGroup
                value={externalLinks.override ?? EXTERNAL_LINK_OVERRIDE_DEFAULT}
                onValueChange={(value) => {
                  externalLinks.onOverrideChange(
                    value === EXTERNAL_LINK_OVERRIDE_DEFAULT
                      ? null
                      : (value as PreviewExternalLinkBehavior),
                  );
                }}
              >
                <MenuRadioItem value={EXTERNAL_LINK_OVERRIDE_DEFAULT}>
                  {`Use default (${EXTERNAL_LINK_BEHAVIOR_LABELS[externalLinks.defaultBehavior].toLowerCase()})`}
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
                Applies to links that leave the current site. Links within the site, the address
                bar, and agent navigation always stay in the preview.
              </p>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
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
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={actions.zoomOut}
              aria-label="Zoom out"
              disabled={disabled}
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
              onClick={actions.zoomIn}
              aria-label="Zoom in"
              disabled={disabled}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={actions.resetZoom}
              aria-label="Reset zoom"
              disabled={disabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        {/*
         * Grouped so the heading has a `MenuGroup` ancestor — `MenuGroupLabel`
          reads its context and throws without one.
         */}
        <MenuGroup>
          {profileName ? (
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">Profile: {profileName}</span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>Clear cookies</MenuItem>
          <MenuItem onClick={actions.clearCache}>Clear cache</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
