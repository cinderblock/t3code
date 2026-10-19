import type { AuthPasskey, AuthPublicAccessConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { KeyRoundIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  addPublicOrigin,
  enrollPasskey,
  isPasskeyCapablePage,
  isPasskeyPromptDismissed,
  revokePasskey,
  updatePublicAccess,
} from "../../environments/primary/passkeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

const EMPTY_CONFIG: AuthPublicAccessConfig = { origins: [], trustedProxies: [] };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function summarize(config: AuthPublicAccessConfig, passkeys: ReadonlyArray<AuthPasskey>): string {
  if (config.origins.length === 0) return "Not set up";
  const hosts = config.origins.map((origin) => new URL(origin).host).join(", ");
  const count = passkeys.length === 1 ? "1 passkey" : `${passkeys.length} passkeys`;
  return `${hosts} · ${count}`;
}

/**
 * Public HTTPS URLs served by a reverse proxy, the proxies trusted for client
 * addresses, and the passkeys that sign in on those URLs. Changes arrive back
 * through the access stream, so this component keeps no copy of server state.
 */
export function PublicAccessSettings({
  publicAccess,
  passkeys,
}: {
  readonly publicAccess: AuthPublicAccessConfig | undefined;
  readonly passkeys: ReadonlyArray<AuthPasskey> | undefined;
}) {
  const config = publicAccess ?? EMPTY_CONFIG;
  const passkeyList = passkeys ?? [];
  const [originInput, setOriginInput] = useState("");
  const [proxyInput, setProxyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      if (!isPasskeyPromptDismissed(cause)) {
        setError(errorMessage(cause, fallback));
      }
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = (next: AuthPublicAccessConfig, key: string) =>
    run(key, () => updatePublicAccess(next), "Could not update public access.");

  const currentOrigin = typeof window === "undefined" ? null : window.location.origin;
  const canEnrollHere = isPasskeyCapablePage();

  return (
    <FoldedSettingsSection
      id="public-access"
      title="Public URL & passkeys"
      summary={summarize(config, passkeyList)}
    >
      <div className={ITEM_ROW_CLASSNAME}>
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">Public URLs</h3>
            <p className="text-xs text-muted-foreground">
              HTTPS addresses where your reverse proxy serves this machine, such as
              https://t3.example.com. Browsers on these addresses can sign in with a passkey.
            </p>
          </div>
          {config.origins.map((origin) => (
            <div key={origin} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{origin}</code>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${origin}`}
                disabled={busy !== null}
                onClick={() =>
                  void saveConfig(
                    { ...config, origins: config.origins.filter((value) => value !== origin) },
                    `origin:${origin}`,
                  )
                }
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = originInput.trim();
              if (!value) return;
              void saveConfig(
                { ...config, origins: [...config.origins, value] },
                "add-origin",
              ).then((saved) => {
                if (saved) setOriginInput("");
              });
            }}
          >
            <Input
              nativeInput
              size="sm"
              className="min-w-0 flex-1"
              placeholder="https://t3.example.com"
              value={originInput}
              disabled={busy !== null}
              onChange={(event) => setOriginInput(event.currentTarget.value)}
            />
            <Button size="xs" variant="outline" type="submit" disabled={busy !== null}>
              Add
            </Button>
          </form>
        </div>
      </div>

      <div className={ITEM_ROW_CLASSNAME}>
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">Trusted proxies</h3>
            <p className="text-xs text-muted-foreground">
              IP addresses or CIDR ranges of your reverse proxy. Their X-Forwarded-For header is
              used to record each client&apos;s real address; everyone else&apos;s is ignored.
            </p>
          </div>
          {config.trustedProxies.map((proxy) => (
            <div key={proxy} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{proxy}</code>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${proxy}`}
                disabled={busy !== null}
                onClick={() =>
                  void saveConfig(
                    {
                      ...config,
                      trustedProxies: config.trustedProxies.filter((value) => value !== proxy),
                    },
                    `proxy:${proxy}`,
                  )
                }
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          ))}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = proxyInput.trim();
              if (!value) return;
              void saveConfig(
                { ...config, trustedProxies: [...config.trustedProxies, value] },
                "add-proxy",
              ).then((saved) => {
                if (saved) setProxyInput("");
              });
            }}
          >
            <Input
              nativeInput
              size="sm"
              className="min-w-0 flex-1"
              placeholder="10.0.0.5 or 10.0.0.0/24"
              value={proxyInput}
              disabled={busy !== null}
              onChange={(event) => setProxyInput(event.currentTarget.value)}
            />
            <Button size="xs" variant="outline" type="submit" disabled={busy !== null}>
              Add
            </Button>
          </form>
        </div>
      </div>

      {passkeyList.map((passkey) => {
        const active = config.origins.includes(passkey.origin);
        return (
          <div key={passkey.id} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-h-5 items-center gap-1.5">
                  <KeyRoundIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <h3 className="text-sm font-medium text-foreground">{passkey.label}</h3>
                  {passkey.administrative ? (
                    <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-3xs text-muted-foreground/80">
                      Full access
                    </span>
                  ) : null}
                  {passkey.backedUp ? (
                    <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-3xs text-muted-foreground/80">
                      Synced
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new URL(passkey.origin).host}
                  <span aria-hidden> · </span>
                  {passkey.lastUsedAt
                    ? `Last used ${DateTime.toDate(passkey.lastUsedAt).toLocaleString()}`
                    : `Added ${DateTime.toDate(passkey.createdAt).toLocaleString()}`}
                </p>
                {!active ? (
                  <p className="text-xs text-warning">
                    Inactive: {passkey.origin} is no longer a public URL. Add it back to use this
                    passkey.
                  </p>
                ) : null}
              </div>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    `passkey:${passkey.id}`,
                    () => revokePasskey(passkey.id),
                    "Could not revoke the passkey.",
                  )
                }
              >
                {busy === `passkey:${passkey.id}` ? "Revoking…" : "Revoke"}
              </Button>
            </div>
          </div>
        );
      })}

      <div className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {canEnrollHere
              ? `Save a passkey for ${currentOrigin}. It signs in from any device your password manager syncs it to, with this session's permissions; saved from a session with the standard permissions, it also gets permissions added in later versions. Revoking a passkey also signs out the sessions it started.`
              : "Open this page on one of the public URLs to save a passkey for that browser. Revoking a passkey also signs out the sessions it started."}
          </p>
          {canEnrollHere ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "enroll",
                  async () => {
                    const passkey = await enrollPasskey({ addOrigin: addPublicOrigin });
                    toastManager.add({
                      type: "success",
                      title: "Passkey saved",
                      description: `"${passkey.label}" can now sign in to ${new URL(passkey.origin).host}.`,
                    });
                  },
                  "Could not save a passkey.",
                )
              }
            >
              <KeyRoundIcon aria-hidden />
              {busy === "enroll" ? "Waiting for passkey…" : "Add passkey"}
            </Button>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </FoldedSettingsSection>
  );
}
