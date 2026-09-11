# Running the fork as sentinel's T3 backend — 2026-09-11

## Goal

Make sentinel the main T3 backend, running this fork (`cinderblock/t3code` `master`) so
the fork's features work there: usage strip and history, queued messages, the commit
graph and the spawn-storm and VCS fixes. Clients that don't know the fork, such as the
upstream iOS app, may simply not show the fork-only UI.

Status: **research only.** Nothing on sentinel has been changed. Server changes go
through the ops repo (`~/git/Personal Projects/ops`, `servers/sentinel/`) with
per-change authorization.

## Findings (verified 2026-09-11)

- **The fork is not published anywhere.** The `t3` npm package is published only by
  upstream's `release.yml` `publish_cli` job (npm trusted publishing, OIDC). The fork
  has Actions enabled, but its Release workflow sits queued on `blacksmith-*`
  runners that don't exist for the fork. It is cancelled hours later, and six runs are
  queued at any time. It can never publish: there is no runner and no npm trust.
- **`t3 service install` always installs from npm.** `pinnedRuntime.ts` runs
  `npm install t3@<cliVersion>` into `~/.t3/runtime/versions/<version>`, and
  `cliVersion` is `apps/server/package.json`'s version. The fork carries upstream's
  version string (`0.0.40`). So running `service install` from a fork build silently
  pins **upstream's** package under a version number that looks right. The same goes
  for `service update` and the RPC self-update.
- **Self-update is only offered under the boot service.**
  `resolveServerSelfUpdateCapability` returns `boot-service` when launcher-managed,
  `desktop-managed` in desktop mode, and otherwise null. A server started with a plain
  `t3 serve` advertises no update, so no client can replace a fork build with upstream.
- **Node.** The built server needs `^22.16 || ^23.11 || >=24.10`, and sentinel's
  v22.22.1 qualifies. Building the monorepo needs the root engines `^24.13.1`, which
  sentinel does not have.
- **Package shape.** `apps/server/dist` is about 116 MB including the web client
  (`dist/client`). Runtime dependencies include `node-pty` (native) and several
  `catalog:` refs, so a copied `dist` needs a real `npm install` on the target.
- **Sentinel today.** It runs Ubuntu 24.04 with no `t3` on PATH, no `t3code` user
  service, no `~/.t3`, and **no `claude` or `codex` CLI**. The provider CLIs must be
  installed and logged in before any agent can run there. It does have the native build
  toolchain (`gcc`, `g++`, `make`, `python3`, `build-essential`), plus `git` and npm
  9.2.0. That matters because `node-pty` 1.1.0 ships prebuilt binaries only for macOS
  and Windows, so on Linux it compiles with node-gyp at install time.
- **Clients.** The fork is 0 commits behind upstream, so the wire protocol matches
  upstream's clients, the iOS app included. Fork-only UI lives in web and desktop.
  Server-side fork behaviour runs regardless of client: queued messages fire and usage
  history keeps recording even while you use the iOS app.

## Options

1. **Build here, ship a tarball (recommended to start).** A plain `pnpm --filter t3
pack` **does not work**: it fails with `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`
   on the `workspace:*` devDependencies. Upstream's publish script
   (`apps/server/scripts/cli.ts publish`) avoids this by writing a stripped manifest
   first, then publishing with pnpm. The working local recipe mirrors that without
   touching the repo:
   - Copy `apps/server/dist` into a temp directory.
   - Write a manifest there with name, version, bin, type, engines and files, plus the
     runtime `dependencies` with `catalog:` resolved from `pnpm-workspace.yaml`. Leave
     out devDependencies and **leave out `overrides`**. npm refuses to pack pnpm's
     `a>b` selector syntax (`Invalid tag name "dbus-next>usocket"`), and npm ignores a
     dependency's overrides anyway.
   - Run `npm pack`.

   On sentinel, install the tarball **as a dependency** into its own directory, the same
   layout as upstream's pinned runtime. Run `node <dir>/node_modules/t3/dist/bin.mjs
serve` under a systemd user unit defined in the ops repo. Updating means repeating
   those steps. Upstream's icon and metadata overrides are skipped, which is cosmetic
   only.

   Two install details that are required, not optional:
   - **The wrapper directory's `package.json` must carry the npm-compatible overrides**:
     the plain `name: version` entries from `pnpm-workspace.yaml`, with no `a>b`
     selectors, no `-` removals and no `npm:` aliases. npm ignores overrides on a
     dependency, so they only work on the root. Without them, `@effect/platform-node-shared`
     floats to `rc.114`, which wants `effect ^rc.114` against the pinned `rc.112`. npm then
     loops re-parsing the 10 MB `effect` record indefinitely; it was killed after 20
     minutes with nothing installed. With them, the install takes about 60 seconds and
     yields one `effect@4.0.0-rc.112`.
   - **npm 11+ blocks install scripts by default**, so `node-pty` and `msgpackr-extract`
     are skipped with `allow-scripts` warnings. Windows gets away with it on prebuilt
     binaries, but Linux has none, so on npm 11+ run `npm approve-scripts node-pty
msgpackr-extract` before or after installing. Sentinel's npm 9.2.0 predates the block.

   **Verified locally on 2026-09-11** on Windows with npm 11.16 and Node 24.18:
   - The tarball is 24 MB and includes the web client. It contains the fork-only UI
     strings: the usage strip, the queue popover and the off-site links setting.
   - It installs and reports `t3 v0.0.40`.
   - `serve` in a throwaway `--base-dir` ran upstream's migrations and all five fork
     migrations, created `fork_usage_samples` and `fork_queued_messages`, listened, and
     printed a pairing URL. Its first response came about 4.6 s after launch. `/`,
     `/pair` and `/index.html` served HTML with status 200, and
     `/.well-known/t3/environment` served JSON. The server then stopped cleanly.
   - Gotcha when repeating the check: give every readiness request a timeout. A
     `fetch` without one hung on an early connection and never gave up. That made
     the first run look like the server never answered, when it was the probe.

   Not yet run on Linux, so the `node-pty` compile on sentinel is still unproven. Its
   toolchain is present.

   **Upstream's own nightlies probably hit the same resolution trap.**
   `t3@0.0.41-nightly` pins `rc.112`, and `platform-node-shared@rc.114` wants
   `effect ^rc.114`. The pinned runtime installs `t3@<version>` as a dependency, so the
   package's overrides don't apply there either. That's an inference; it hasn't been tested.

2. **Clone and build on sentinel.** Same `serve` unit, but sentinel builds it with
   `git pull`, `vp i` and a build. Needs Node 24 on sentinel, which is an ops repo change.
3. **Publish the fork under its own npm name from fork CI.** This is the only path that
   restores `t3 service install` and one-click "Update server". It needs a release
   workflow on the fork, a name claim (the 0.0.0 exception), trusted publishing, and a
   fork patch so `pinnedRuntime.ts` installs the fork's package, since it hardcodes
   `t3` and `node_modules/t3/dist/bin.mjs`. It also needs a version scheme that can't
   collide with upstream's.

## Things not to do

- Don't run `t3 service install` or `service update` with a fork build. It installs
  upstream from npm under the same version number.
- Don't publish from a CLI (global rule). Option 3 is CI-only.
- Don't change sentinel directly. Stage the change in the ops repo and get a yes.

## Open questions for the user

1. Which option? I recommend 1 now, and 3 only if one-click updates matter.
2. Disable the fork's `Release` workflow? It only ever queues and gets cancelled. I
   recommend yes: `gh workflow disable Release -R cinderblock/t3code`, which is
   reversible.
3. Which provider CLIs should sentinel carry: Claude Code, Codex, or both?
