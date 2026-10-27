import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices } from "./appInit";
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

const router = startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

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

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
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
    if (reloadScheduled) return;
    throw error;
  });
