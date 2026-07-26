import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Forward renderer-side errors to a desktop log file (main.ts writes ~/.t3/{dev,userdata}/logs/renderer.log).
// No-op outside Electron, or if the preload didn't expose __t3CrashLog.
declare global {
  interface Window {
    __t3CrashLog?: {
      send: (payload: { level: string; source: string; message: string; data?: unknown }) => void;
    };
  }
}
{
  const bridge = window.__t3CrashLog;
  if (bridge) {
    const serializeArg = (a: unknown): unknown => {
      if (a instanceof Error) {
        return { name: a.name, message: a.message, stack: a.stack };
      }
      try {
        return JSON.parse(JSON.stringify(a));
      } catch {
        return String(a);
      }
    };
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
    window.addEventListener("error", (event) => {
      safeSend({
        level: "error",
        source: "window.onerror",
        message: event.message ?? "unknown error",
        data: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error ? serializeArg(event.error) : undefined,
        },
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      safeSend({
        level: "error",
        source: "unhandledrejection",
        message: reason instanceof Error ? reason.message : String(reason),
        data: { reason: serializeArg(reason) },
      });
    });
    const wrapConsole = (level: "error" | "warn") => {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        safeSend({
          level,
          source: `console.${level}`,
          message: args
            .map((a) => (typeof a === "string" ? a : ""))
            .filter(Boolean)
            .join(" "),
          data: { args: args.map(serializeArg) },
        });
        original(...args);
      };
    };
    wrapConsole("error");
    wrapConsole("warn");
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

const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {clerkPublishableKey && hasCloudPublicConfig() ? (
      isElectron ? (
        <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : (
      app
    )}
  </React.StrictMode>,
);
