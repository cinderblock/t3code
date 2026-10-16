# Issues

Known problems found while working on something else. Each entry is a seed for a separate fix.

## WebSocket upgrade accepts cookie sessions from any Origin

**Fixed upstream** by #18509 (`48595c787c`), arrived in merge `b0b47eefeb`: every cookie-authenticated
request, the upgrade included, must now be same-origin by `Sec-Fetch-Site`, match `Host` /
`X-Forwarded-Host`, or come from a trusted app origin. Kept below for the record.

`authenticateWebSocketUpgrade` (`apps/server/src/auth/EnvironmentAuth.ts`, used by
`apps/server/src/ws.ts` and `apps/server/src/device/DeviceHubProxy.ts`) authenticates a browser
cookie without checking the `Origin` header. CORS does not apply to WebSockets, and the session
cookie is `SameSite=Lax`, which still attaches it on _same-site_ requests. So once an environment
is served on a public domain (e.g. `t3.example.com` behind a tunnel), a page on any sibling
subdomain (`*.example.com`) that is compromised or hosts untrusted content can open the RPC socket
with the user's session and drive agents (`orchestration:operate`). Reproduce: from a page on
another subdomain of the same registrable domain, `new WebSocket("wss://t3.example.com/ws")` while
signed in.

Why it matters: the session grants shell-level control of the host. A fix probably checks
`Origin` for cookie-authenticated upgrades against the request's own origin, configured public
origins, and the desktop renderer origins. Careful: cloudflared rewrites `Host` to the local
service by default, so comparing `Origin` to `Host` alone would break proxied access.

## Fork UI fails upstream's `shadcn/no-restyle` lint

`vp lint` errors on fork-only markup (upstream's rules, not upstream code):

- `apps/web/src/components/Sidebar.tsx` host-filter row: `<Toggle variant="segmented">` with
  `gap-1.5 text-sidebar-muted-foreground data-pressed:text-sidebar-foreground` (two toggles), and
  `<Badge className="tabular-nums">` for the hidden-thread count.
- `apps/web/src/components/chat/ChatComposer.tsx` queue-draft ("send later") button:
  `<Button className="rounded-full text-muted-foreground/80 …">`.

Each needs a design call: a sidebar-tone segmented `Toggle` variant (and a numeric `Badge`
variant) in `components/ui`, or reuse of an existing variant. CI's lint step fails on these.
