import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";

// Forward renderer-side errors to a desktop log file (main.ts writes ~/.t3/{dev,userdata}/logs/renderer.log).
// No-op outside Electron, or if the preload didn't expose __t3CrashLog.
declare global {
  interface Window {
    __t3CrashLog?: {
      send: (payload: { level: string; source: string; message: string; stack?: string }) => void;
    };
  }
}
{
  const bridge = window.__t3CrashLog;
  if (bridge) {
    const errorStack = (value: unknown): string | undefined =>
      value instanceof Error && typeof value.stack === "string" ? value.stack : undefined;
    let inSend = false;
    const safeSend = (payload: Parameters<typeof bridge.send>[0]) => {
      if (inSend) return;
      inSend = true;
      try {
        bridge.send(payload);
      } finally {
        inSend = false;
      }
    };
    // Only uncaught failures: console output is not forwarded, since it would carry
    // whatever the app logged verbatim and bypass the log redaction main.ts applies.
    window.addEventListener("error", (event) => {
      const stack = errorStack(event.error);
      safeSend({
        level: "error",
        source: "window.onerror",
        message: event.message ?? "unknown error",
        ...(stack !== undefined ? { stack } : {}),
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const stack = errorStack(reason);
      safeSend({
        level: "error",
        source: "unhandledrejection",
        message: reason instanceof Error ? reason.message : String(reason),
        ...(stack !== undefined ? { stack } : {}),
      });
    });
  }
}

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = <AppRoot router={router} />;

// Managed auth is cloud-only, and the Electron Clerk provider bundles the full
// clerk-js runtime. Loading only the selected runtime as a split chunk keeps
// every Clerk byte out of the startup graph for local-mode users, and keeps
// the bundled clerk-js out of the browser build entirely.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve everything that first commit needs, the selected
// managed-auth runtime and the initial route's split chunks, before
// rendering, so the splash holds until real UI paints instead of dropping to
// a blank window while chunks download.
export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(([ManagedAuthShell]) => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary. Skip the
    // paint when a reload is on its way, and only re-arm the guard after a boot
    // that fetched every chunk it asked for.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // Let the bootstrap entry show the error unless a reload is already scheduled.
    if (reloadScheduled) return;
    throw error;
  });
