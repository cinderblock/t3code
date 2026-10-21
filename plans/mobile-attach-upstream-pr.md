# Mobile web: attachments after the first message are lost — upstream PR

## Goal

Upstream (`pingdotgg/t3code`) a fix for: on a phone browser, attaching an image works in a new
thread but every attach after the first message is silently dropped.

## Cause (verified)

The hidden `<input type="file">` behind the paperclip lived inside the composer footer, which
`ChatComposer` unmounts when the mobile composer collapses (`isComposerCollapsedMobile`). Opening
the OS picker blurs the editor, the composer collapses, the footer (and the input) unmounts, and
the picked file's `change` event goes nowhere. A new thread keeps the composer force-expanded
(`forceExpandedOnMobile`, draft hero state), which is why the first attach worked.

Evidence: server traces showed no `attachments.createUploadUrl` / upload POSTs from the iPhone
(UA `CriOS`, iOS 27.2) after the first attach; after the fix, three consecutive messages
(one with two images) uploaded fine (POSTs 12:02:23, 12:03:39, 12:04:02 on 2026-10-21, all 204).

## Environment / context

- Fork fix: `553f6801d1` on `master` (fork, not pushed). Running in the desktop build since
  2026-10-21 02:24 (restarted by `scripts/restart-t3-when-idle.ps1`).
- Upstream refactored the composer on 2026-10-21 (#22689, #22719–#22722); the input moved into
  `ComposerAttachButton` in `apps/web/src/components/chat/ComposerAttachmentStrip.tsx`, still
  rendered inside the collapsible footer. So the fork commit doesn't cherry-pick; it is ported.
- PR worktree: `C:\Users\camer\.t3\worktrees\t3code\mobile-attach-pr`, branch
  `fix/mobile-attach-after-first-message`, from `upstream/main` `0bdf33a34d`.
- Worktree setup needs `T3CODE_PROJECT_ROOT=C:\Users\camer\git\t3code` when run by hand.

## Decisions already made (don't re-ask)

- Report as a PR, not an issue first (CONTRIBUTING allows small obvious bug fixes directly).
- User tests the upstream-based branch on the iPhone before the PR is opened.
- Don't merge upstream into the fork as part of this; that's its own thread later.

## Plan / steps

1. [x] Worktree from `upstream/main`, install.
2. [x] Port: split `ComposerAttachInput` (the `<input>`) from `ComposerAttachButton` (the
       paperclip); `ChatComposer` owns the ref and renders the input outside the footer.
3. [x] Lint + typecheck the two files; commit (`5745eba679` on the PR branch).
4. [x] Seed dev DB (`vp run migrate-dev-db`), start dev server, give the user the pairing URL.
       Dev server: `vp run dev --host 0.0.0.0` (background task; web 7438, server 15478). Phone
       access via forwarder `C:\temp\t3runs\fwd-7439.mjs` (0.0.0.0:7439 → localhost:7438, PID 27744).
5. [x] User repeats the iPhone test on the dev server: "Test 1/2/3" in one existing thread
       (20:27:45, 20:30:02, 20:30:15 UTC), each with an image, uploads 204, all reached the agent.
6. [x] Rebased onto `upstream/main` `e78f580468` (one trivial conflict: #23049 moved
       `pastedTextFileNamesRef` out), lint + typecheck re-run, pushed `14e06d8eee` to
       `origin/fix/mobile-attach-after-first-message`, opened
       https://github.com/pingdotgg/t3code/pull/23083 and linked it to the thread.
7. [x] Stopped the dev server and forwarder. [ ] Remove the worktree once the PR is merged or
       closed (keep it meanwhile for review changes). ← current: waiting on upstream review
8. [ ] Fork: at the next upstream merge, take upstream's version and drop `553f6801d1` if the PR
       landed; otherwise re-apply on the refactored composer.

## Findings / gotchas

- **`vp run dev --share` fails on this machine**: "could not serve port 7438 on the tailnet". The
  tailnet is Headscale (`CertDomains` empty), which issues no
  HTTPS certs, so `tailscale serve --https=…` can't work. Not something to fix here (infra).
- **`--host 0.0.0.0` doesn't expose the web server**: it only sets the backend's `T3CODE_HOST`;
  dev-runner deletes `HOST` so Vite stays on `::1`. Vite does accept IP `Host` headers, so a plain
  TCP forwarder works. The attach path needs no secure context (`randomUUID` uses
  `getRandomValues`).
- Worktree `scripts/setup-worktree.ts` needs `T3CODE_PROJECT_ROOT` when run by hand.
- Stopping the dev server's background task left Vite and the backend running, both times; they
  had to be killed via the `vp run … dev` runner's PID (verified by command line, `taskkill /T`).
- Upstream was mid-way through a composer refactor series on 2026-10-21 (#22689–#22722, #23049,
  #23058, #23060); expect more churn in `ChatComposer.tsx` and possible rebase conflicts.
- Upstream issue #2803 (no paperclip on mobile) is unrelated/closed; its fix (#8236) introduced
  the paperclip this bug is in. No existing report of this bug.

## Progress log

- 2026-10-21: diagnosed, fork fix committed and verified on iPhone; PR worktree created and fix
  ported.
- 2026-10-21: upstream version verified on iPhone via the worktree dev server; PR #23083 opened.
- 2026-10-21: leak audit. The public fork, PR #23083 and upstream issues never contained the
  public T3 hostname or the Headscale hostname, but two unpushed plan docs did. Rewrote the 42
  fork-only commits from 2026-10-12 on (user approved) so neither appears anywhere in unpushed
  history: `git filter-repo --replace-text` in a bare clone, with `origin/master` and
  `upstream/main` excluded so upstream commits keep their hashes, then re-signed with the same SSH
  key (script `C:	emp	3runs
esign.py`) and moved `master` with a compare-and-swap
  `update-ref`. Hash citations in plans and ISSUES.md updated to the new hashes. Old master is
  kept locally as `refs/backup/master-before-hostname-redact-2026-10-21`; it still contains the
  hostnames, so never push it.

## Open questions for the user

(none)

## Things not to do

- Don't cherry-pick `553f6801d1` onto upstream; the code moved.
- Don't start the dev server against `~/.t3/userdata`.
- Don't write private hostnames (the public T3 domain, the Headscale server) into files in this
  repo; the fork is public.
- Don't run `git filter-repo` over the fork without excluding `upstream/main`: it rewrites
  upstream's commits too (it strips their signatures), which detaches the fork from upstream.
