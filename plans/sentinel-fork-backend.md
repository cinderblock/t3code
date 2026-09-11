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
  installed and logged in before any agent can run there.
- **Clients.** The fork is 0 commits behind upstream, so the wire protocol matches
  upstream's clients, the iOS app included. Fork-only UI lives in web and desktop.
  Server-side fork behaviour runs regardless of client: queued messages fire and usage
  history keeps recording even while you use the iOS app.

## Options

1. **Build here, ship a tarball (recommended to start).** On noook, run
   `vp run --filter t3 build` and then `pnpm --filter t3 pack`. Copy the tarball to
   sentinel, run `npm install -g ./t3-*.tgz`, and run `t3 serve` under a systemd user
   unit defined in the ops repo. Updating means repeating those steps. **Unverified:** that
   `pnpm pack` rewrites the `catalog:` deps correctly (pnpm documents it does on
   pack/publish). Upstream's publish script also applies icon and metadata overrides a
   plain pack skips, which is cosmetic only.
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
