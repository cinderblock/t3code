import { AuthAccessWriteScope } from "@t3tools/contracts";
import { useEffect } from "react";

import { fetchSessionState, takePairedWithCredential } from "../../environments/primary/auth";
import {
  addPublicOrigin,
  canEnrollPasskeyHere,
  enrollPasskey,
  isPasskeyCapablePage,
  isPasskeyPromptDismissed,
} from "../../environments/primary/passkeys";
import { toastManager } from "../ui/toast";

/**
 * Right after a browser pairs with a token on a domain it reached directly,
 * offers to save a passkey so the next visit needs no pairing link. Access
 * managers can enroll on an origin that is not configured yet; saving adds it.
 */
export function PasskeyEnrollmentOffer() {
  useEffect(() => {
    // Consumed once per page load, so a remount does not offer twice.
    if (!takePairedWithCredential() || !isPasskeyCapablePage()) return;

    void (async () => {
      const session = await fetchSessionState();
      const canManageAccess = session.scopes?.includes(AuthAccessWriteScope) === true;
      if (!canManageAccess && !(await canEnrollPasskeyHere())) return;

      const host = window.location.host;
      const offerId = toastManager.add({
        type: "info",
        title: "Sign in with a passkey next time?",
        description: `Save a passkey so this browser can sign back in to ${host} without a pairing link.`,
        timeout: 0,
        actionProps: {
          children: "Save passkey",
          onClick: () => {
            toastManager.close(offerId);
            void enrollPasskey(canManageAccess ? { addOrigin: addPublicOrigin } : {}).then(
              (passkey) =>
                toastManager.add({
                  type: "success",
                  title: "Passkey saved",
                  description: `"${passkey.label}" can now sign in to ${host}.`,
                }),
              (error: unknown) => {
                if (isPasskeyPromptDismissed(error)) return;
                toastManager.add({
                  type: "error",
                  title: "Could not save a passkey",
                  description: error instanceof Error ? error.message : undefined,
                });
              },
            );
          },
        },
      });
    })().catch(() => undefined);
  }, []);

  return null;
}
