# Passkey login for a public HTTPS URL

## Goal

Let the user reach their T3 server at a public URL (e.g. `https://t3.example.com`) from any
browser, with no VPN and no pre-provisioned cookie/pairing link, by signing in with a passkey
(WebAuthn). First contact still uses an ordinary pairing link; right after pairing, the browser
offers to enroll a passkey bound to that public origin. Later visits show "Sign in with passkey".

Out of scope for this thread (another agent owns it): the HTTPS reverse proxy / TLS / routing
in front of the T3 server (Caddy etc., via the ops repo). DNS-01 / ACME inside T3: decided
excessive — TLS terminates at the proxy.

## Environment / context

- Repo: `C:\Users\camer\git\t3code` (fork; `master` is the fork's main line, upstream is `main`).
- Server auth lives in `apps/server/src/auth/`:
  - `EnvironmentAuth.ts` — service: pairing-credential → session exchange, request authentication
    (cookie > bearer > DPoP > legacy cookie > dev cookie).
  - `http.ts` — `authHttpApiLayer` handlers; `appendSessionCookie` / browser-session cookie
    (`httpOnly`, `sameSite: lax`, path `/`, no `secure` flag today).
  - `SessionStore.ts` — sessions, default TTL 30 days; methods `browser-session-cookie`,
    `bearer-access-token`, `dpop-access-token`.
  - `EnvironmentAuthPolicy.ts` — `ServerAuthDescriptor` (policy, bootstrapMethods, sessionMethods,
    sessionCookieName). Natural place to advertise "passkey sign-in available".
- HTTP contract: `packages/contracts/src/environmentHttp.ts` (`EnvironmentAuthHttpApi`, group
  `auth`); schemas in `packages/contracts/src/auth.ts`.
- Persistence: fork-owned migrations in `apps/server/src/persistence/ForkMigrations.ts`
  (`fork_`-prefixed tables, own tracking table). Next free fork id: **6**. Repo pattern example:
  `apps/server/src/persistence/AuthPairingLinks.ts`.
- Server settings: `ServerSettings` in `packages/contracts/src/settings.ts` (server-authoritative,
  shared by desktop and `npx t3`).
- Web unauthenticated flow: `apps/web/src/routes/pair.tsx`,
  `apps/web/src/components/auth/PairingRouteSurface.tsx`,
  `apps/web/src/environments/primary/auth.ts` (`bootstrapServerAuth`, `submitServerAuthCredential`).
- "Reach this machine via" picker: `apps/web/src/components/settings/ConnectionsSettings.tsx`
  (~line 887), fed by `AdvertisedEndpoint`s (`packages/contracts/src/remoteAccess.ts`) that today
  come only from desktop main (`apps/desktop/src/backend/DesktopServerExposure.ts`). Desktop already
  supports custom HTTPS endpoints via env `T3CODE_DESKTOP_HTTPS_ENDPOINTS` (no UI).
- Client IP today: socket remote address only (`apps/server/src/auth/utils.ts`); no proxy-header
  trust anywhere in auth.

## Design (proposed)

1. **Config: server setting `publicOrigins`** (list of `https://host[:port]` origins) plus
   optional `trustedProxies` (IPs/CIDRs). Server-side so it works for desktop and `npx t3`.
   The server advertises each public origin as an `AdvertisedEndpoint` (source `server`,
   reachability `public`, hosted-HTTPS compatible) so it appears under "Reach this machine via"
   and pairing links/QRs can target it. Editable from Settings → Connections.
2. **WebAuthn verification**: `@simplewebauthn/server` (server) + `@simplewebauthn/browser`
   (web). RP ID = hostname of the matching configured origin; expected origin = that origin
   (checked from the signed `clientDataJSON`, so proxy headers are not trusted for this).
   Discoverable credentials (resident keys), user verification required, attestation `none`.
3. **Persistence**: fork migration 6 → `fork_auth_passkeys` (credential id, COSE public key,
   counter, transports, rp id, label, subject, scopes, created/last-used/revoked timestamps).
4. **Challenges**: short-lived (5 min), single-use, in-memory map in a `PasskeyService`.
5. **Endpoints** (contract `auth` group):
   - `POST /api/auth/passkeys/registration-options` (authenticated, browser cookie session on a
     configured origin) → creation options.
   - `POST /api/auth/passkeys/register` (authenticated) → stores passkey.
   - `POST /api/auth/passkeys/login-options` (unauthenticated) → request options.
   - `POST /api/auth/passkeys/login` (unauthenticated) → verifies assertion, issues a
     `browser-session-cookie` session with the passkey's scopes; sets the cookie.
   - `GET /api/auth/passkeys` / `POST /api/auth/passkeys/revoke` (`access:read` / `access:write`).
6. **Scopes**: a passkey carries the scopes of the session that enrolled it (cannot widen).
7. **Session after passkey login**: still an HttpOnly session cookie (that is how every browser
   session works here). "No cookies needed" = no pre-provisioned cookie or pairing link; the
   passkey replaces the pairing token. Cookie gains `Secure` when the request came via a
   configured HTTPS origin.
8. **Web UI**:
   - Pair screen: "Sign in with passkey" button when the descriptor says the current origin is a
     passkey origin (and conditional-mediation autofill where supported).
   - After a successful pairing on a passkey origin: prompt "Save a passkey for next time?".
   - Settings → Connections: public-URL editor; passkey list with rename-free revoke; "Add passkey".
9. **Surfaces**: web served from the public origin — yes. Desktop renderer (`t3code://`) — not a
   WebAuthn origin for the public host; keeps pairing. Mobile — keeps pairing (native passkeys
   need associated domains; later). Hosted `app.t3.codes` — not in v1 (would need WebAuthn
   Related Origin Requests via `/.well-known/webauthn`; note as follow-up). MCP/agents — passkey
   list/revoke are access-management; no agent tool in v1.

## Decisions already made (don't re-ask)

- Passkeys are a login method for a public HTTPS origin; first enrollment rides on the existing
  pairing-link flow (user's direction).
- No DNS-01/ACME in T3; TLS terminates at the user's reverse proxy (user agreed it's excessive).
- HTTPS routing/proxy is another agent's job; don't touch ops/Caddy from this thread.
- Scopes: a passkey carries the scopes of the session that enrolled it, which come from the
  pairing link the user created (user: "I already pick permissions that token gets").
- Config: server setting + Settings → Connections UI (works for desktop and `npx t3`).
- Work directly on `master` in the shared main checkout; stage only own files.
- v1 surface: web served from the public URL only. Hosted app (Related Origins) and native
  mobile passkeys are follow-ups.

## Plan / steps

- [x] 1. Get user answers on open questions.
- [x] 2. Contracts: settings fields, descriptor field, passkey schemas + endpoints.
- [x] 3. Server (`e3b2e277dc`): fork migration 6, repository, `PasskeyService`, handlers, cookie `Secure`,
      trusted-proxy client IP, advertised public endpoint. Focused tests.
- [x] 4. Web (`7c995be3a3`): pair-screen passkey sign-in, post-pair enrollment prompt, Connections settings UI.
- [x] 5. Docs: `docs/internals/environment-auth.md` (passkey trust model), `docs/user/remote-access.md`.
- [x] 6. Targeted typecheck/lint/tests; commit in logical steps.
- [ ] 7. **← current** Real-browser check against a dev server on an HTTPS origin (needs the
      user's OK per AGENTS.md, and the HTTPS route from the other agent for the real domain).

## Findings / gotchas

- Config lives in its own fork table (`fork_auth_public_access`), not `ServerSettings`: the
  generic settings patch only needs `orchestration:operate`, but changing who can sign in is
  access management (`access:write`). Same precedent as `defaultTheme` being absent from the patch.
- Skipped `@simplewebauthn/server`: v13+/v14 depend on `@peculiar/x509` + `reflect-metadata`
  (global polyfill). With `attestation: "none"` nothing needs X.509, so verification is ~300 lines
  over `node:crypto` + `@levischuck/tiny-cbor` (`apps/server/src/auth/webauthn.ts`), tested with a
  software authenticator (`apps/server/src/auth/testing/softwareAuthenticator.ts`).
- Passkeys/config reach clients as optional fields on the access-stream _snapshot_; a change
  re-sends a snapshot instead of new event types, because older clients fail to decode unknown
  event types but already handle mid-stream snapshots.
- An HTTPS `AdvertisedEndpoint` with `hostedHttpsApp: "compatible"` gets an `app.t3.codes/pair?host=`
  link in the share picker (`resolveAdvertisedEndpointPairingUrl`). Public URLs must not be marked
  compatible, or pairing lands on the hosted app where no passkey for the domain can be saved.
  Seen live 2026-10-12, fixed in `b291620a2b`.
- First live run (2026-10-12): config saved and the access stream re-sent its snapshot (trace shows
  `PublicAccess.setConfig` then `listPasskeys`), so the single-instance/stream wiring works.
- `ForkMigrations.test.ts` hardcodes the fork migration list; add new entries there too.
- Unauthenticated `login-options` returns the same 404 whether the origin is unconfigured or has
  no passkeys, so it does not reveal configured origins.

- Desktop's "Custom HTTPS" endpoint already exists but only via env var
  `T3CODE_DESKTOP_HTTPS_ENDPOINTS`; there is no UI and `npx t3` has no equivalent.
- WebAuthn needs a secure context and the RP ID must be a registrable suffix of the page origin,
  so passkeys only work when the web app is served from the public origin itself.

## Progress log

- [x] Surveyed auth, pairing, endpoints, persistence, web pair flow.
- [x] Server: verifier, PublicAccess service, migration, handlers, access stream (`e3b2e277dc`).
      Tests: `webauthn.test.ts` (11), `PublicAccess.test.ts` (15), HTTP route test in
      `auth/http.test.ts` (enroll + sign-in end to end, Secure cookie, scopes inherited).
- [x] Web: pair-screen sign-in, post-pair toast, Settings panel, public URLs in
      "Reach this machine via" (`7c995be3a3`).
- [x] Docs: `docs/user/remote-access.md` ("Your own domain with a passkey"),
      `docs/internals/environment-auth.md` (trust model).
- [ ] Real-browser verification (not done; see step 7).

## Follow-ups (not in v1, by decision or scope)

- Mobile settings has no passkey/public-URL management UI (desktop and web do).
- No `t3 auth` CLI for public origins or passkeys; a headless server is configured from a browser
  admin session (e.g. the startup pairing URL).
- Hosted `app.t3.codes` passkeys would need WebAuthn Related Origin Requests
  (`/.well-known/webauthn` on the user's domain).
- Native mobile passkeys need associated domains.

## Open questions for the user

(See chat; answers get recorded under "Decisions already made".)

## Things not to do

- Don't trust `X-Forwarded-*` headers from arbitrary peers — only from configured trusted proxies.
- Don't touch Caddy/Cloudflare/ops — another agent, and per-change authorization is required.
- Don't let passkey login fall back to anything weaker on verification failure.
