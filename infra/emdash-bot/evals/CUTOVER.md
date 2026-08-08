# emdash-bot cutover — PR body draft

Draft for the big-bang cutover PR. The eval-gate section is filled in after the
live pre-flight run (operator step; see `evals/README.md`). Do not open the PR
until the gate section reads GATE PASSED.

## Summary

Retires the gen-1 Actions-driven issue-automation pipeline and hands all
issue-side bot work to the `infra/emdash-bot` worker (per-issue Orchestrator
Durable Object, generated state machine, classify + investigate agents, Flue 2,
container execution layer). Gen-1 was not in production use, so this is a
big-bang cutover with no shadow period.

## What is deleted

- **`.flue/` (root workspace)** — gen-1 Flue 0.11 CLI on Actions runners. Its
  domain knowledge (the repro/diagnose/verify skill prompts) was already ported
  into `infra/emdash-bot/.flue/skills/` in an earlier slice, so nothing is lost.
- **`.github/workflows/investigate.yml`** — the gen-1 reproduction runner.
- **`.github/workflows/reporter-reply.yml`** — reporter confirm/reject handling.
- **`.github/workflows/maintainer-reply.yml`** — maintainer `@emdashbot` directives.
- **`.github/workflows/bot-cleanup.yml`** — issue-close branch reaping + a daily
  stale-artifacts sweep. The close path is absorbed by the DO
  (`cleanupOnClose` → `runReapBranch`); the daily global sweep is **not** — see
  Carries.

Also removed the now-dead `investigate.yml` entry from `.github/zizmor.yml`
(`adhoc-packages` ignore) and corrected a stale `investigate.yml` reference in a
`preview-releases.yml` comment (comment only; the workflow is untouched and
independent).

## What replaces it

The deployed worker. Webhook deliveries land in the per-issue Orchestrator DO;
classification is automatic and cheap; the expensive investigate/fix runs are
maintainer-triggered (`@emdashbot investigate` / `@emdashbot fix`). The fix loop
pushes a `bot/fix-<n>` branch, `preview-releases.yml` publishes a pkg.pr.new
preview on that push, and the worker asks the reporter to confirm it against
their own site before any PR opens. `TRIAGE.md`'s bot sections are updated to
describe this flow and the new `bot:*` state labels.

`preview-releases.yml` is **not** retired — it also serves `main` and PR
previews and is independent of the deleted workflows (verified: nothing outside
the deleted set `uses:`/`needs:` any of them; the only remaining references are
descriptive comments inside the worker source).

## Rollback

Redeploy the previous emdash-bot worker version (Workers versioning) and
re-point the GitHub App webhook. Rollback does **not** resurrect the deleted
Actions workflows — restoring them is a separate `git revert` if ever needed.

## Project-sync decision (deletion list is four, not five)

The design listed `triage-project-sync.yml` for deletion. It is **kept**, and the
deletion list is four workflows:

- It needs **org-level Projects v2 write** (an org-scoped installation token with
  `permission-organization-projects: write`), a different auth surface than the
  per-repo installation token the worker mints per issue. Porting it into the
  worker's tick/webhook path is a later org-Projects singleton, not a cutover
  change.
- It also keys off the **old `triage/*` label vocabulary**, which the new worker
  no longer emits (the machine emits `bot:*` state labels, each carrying a
  `boardColumn`). So board sync is effectively **paused** after cutover until
  either this workflow's label→column map _and_ the Projects v2 board's option
  set are migrated to the new `bot:*` vocabulary, or the sync is absorbed into a
  worker singleton. Leaving the workflow in place keeps its working GraphQL
  plumbing (option lookup, archive/unarchive) available for that migration.

This is a documented gap, not a silent one: **the Auto-Triage board stops
updating at cutover** until the follow-up lands.

## Carries

1. **Preview-build poll budget** (`PREVIEW_BUILD_TIMEOUT_MS = 10 min`).
   Measured against recent `preview-releases.yml` runs (`main` pushes, via
   `gh api`): ~2.5–7 minutes end-to-end including queue time, worst recent run
   ~6m46s. The 10-minute budget covers it with ~30% headroom, so it is
   **adequate**. Two notes: the in-code comment "Publishing normally lands
   within ~60s" understates the measured 3–7 min and should be updated; if real
   `bot/fix-*` previews prove slower than `main` (larger diff, cold caches),
   bump to 15 min or start the clock at push time. No change made here.

2. **`awaiting_reporter` + issue close** (real edge, documented, not patched).
   `cleanupOnClose` reaps `bot/fix-<n>` on close but deliberately does not touch
   machine state. If an issue is closed while `awaiting_reporter` and later
   reopened and confirmed, `openDraftPr` runs against a branch that was reaped →
   failure. Recommended fix (a slice-4 behavioral change, left out of the
   cutover): on close while `awaiting_reporter`, clear to `reproduced` (the
   diagnosis survives), or guard `openDraftPr` against a missing head branch and
   fall back to `reproduced`.

3. **Raw-notes marker injection** (verified safe, no change needed).
   Reply handling keys off the webhook **delivery id** (idempotent dedup) and
   the comment body's classification, not marker text. The only
   `hasIssueCommentMarker` check uses a **random-UUID** marker
   (`<!-- emdashbot-event:<uuid> -->`), which is unspoofable. The `bot-ask`
   timestamp marker is written into the ask body for gen-1 parity but is never
   read by the worker.

4. **Global artifacts sweep** (singleton-cron gap, documented).
   `bot-cleanup.yml`'s daily job swept _all_ `bot/artifacts-*` branches older
   than 90 days — a global operation a per-issue DO cannot do. The per-issue
   close/expire/reject reaping is absorbed; the global sweep is not. Follow-up:
   a worker `scheduled()` cron singleton that lists and prunes stale
   `bot/artifacts-*` branches. Low urgency (each issue reaps its own artifacts
   on close; the leak is only issues never closed or whose close was missed).

5. **pkg.pr.new shorthand `emdash`** (verify live; fails safe).
   The next-gen fix loop uses `https://pkg.pr.new/emdash@bot/fix-<n>` for **both**
   the readiness poll and the reporter's install command (one source,
   `preview.ts`), so the poll genuinely gates the ask. `emdash` is the real
   unscoped published package (`packages/core`). Confirm the shorthand resolves
   for this monorepo against a real `bot/fix-*` preview during deploy; if
   pkg.pr.new needs the explicit `emdash-cms/emdash/emdash@<ref>` triple form,
   update `previewUrl`/`previewInstallCommand`. Fail-safe: a non-resolving
   shorthand makes the poll time out and fall back to `reproduced` rather than
   post a dead link. (The dormant legacy `awaiting_feedback` lane in
   `renderAgentComment` uses the full `emdash-cms/emdash@` form — a consistency
   nit, not on the next-gen path.)

## Eval gate (fill after the live pre-flight run)

Run `pnpm evals -- --all` against the staging worker (see `evals/README.md`),
then paste the summary here. **Do not merge until this reads GATE PASSED.**

```
GATE: <PASSED|FAILED>  --  zero confident-wrong: <yes|NO (n)>
total <n>   pass <n>   miss <n>   confident-wrong <n>   error <n>
```

- [ ] Zero confident-wrong across all 26 cases.
- [ ] Zero harness errors (every case produced a verdict).
- [ ] Confirmed-bug reproduction rate recorded (misses are acceptable; note them).
- [ ] Not-reproducible cases all landed `not_reproduced` (no false positives).
- [ ] kimi k2.7-code 429 handling exercised; no run lost to a model flake.
