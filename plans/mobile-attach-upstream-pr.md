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

- Fork fix: `3c7d9a8d7e` on `master` (fork, not pushed). Running in the desktop build since
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
5. [ ] User repeats the iPhone test on the dev server (existing thread, attach in 2+ messages).
       ← current
6. [ ] Push branch to `origin` (fork), open PR against `pingdotgg/t3code:main`, link it.
7. [ ] Stop the dev server (by its PID), remove the worktree when the PR is merged/closed.
8. [ ] Fork: at the next upstream merge, take upstream's version and drop `3c7d9a8d7e` if the PR
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
- Stopping the dev server's background task left Vite and the backend running; they had to be
  killed via their parent PID (verified by command line, `taskkill /T`).
- Upstream issue #2803 (no paperclip on mobile) is unrelated/closed; its fix (#8236) introduced
  the paperclip this bug is in. No existing report of this bug.

## Progress log

- 2026-10-21: diagnosed, fork fix committed and verified on iPhone; PR worktree created and fix
  ported.

## Open questions for the user

(none)

## Things not to do

- Don't cherry-pick `3c7d9a8d7e` onto upstream; the code moved.
- Don't start the dev server against `~/.t3/userdata`.
