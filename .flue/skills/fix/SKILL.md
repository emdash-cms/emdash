---
name: fix
description: Write the fix when verify says bug and diagnose says high confidence. Follow EmDash conventions, confirm the reproduce test now passes, run lint and typecheck, stage but do not commit.
---

# Fix

You are here because verify returned `bug`, diagnose pinned the cause with at least `medium` confidence, and diagnose rated the fix `mechanical` or `clear-best-option`. Diagnose handed you a **proposed fix** -- a concrete plan naming the file and the change. Your job is to implement that plan, prove it works, leave the working tree in a state the orchestrator can commit, and report what you did. The hard reasoning is already done; do not re-litigate the diagnosis unless reading the code convinces you it is wrong (in which case abandon -- see below).

Read diagnose's proposed fix first and treat it as your spec. Implement that change. If, once you are in the code, the plan turns out to be wrong or incomplete, do not improvise a different large change -- abandon with `fixed: false` and say why, so a human can re-diagnose.

**What your output is, and is not.** You are not merging anything, and you are not even opening a PR. The orchestrator pushes your staged change to a `bot/fix-<n>` branch and asks the original reporter to install a preview build and confirm it resolves their issue. A maintainer reviews before anything lands on `main`. So the bar is "a correct, conventions-respecting change that makes the reproduce test pass" -- not "a perfect, unimprovable patch." A clear, test-backed fix is worth shipping for verification even when it is more than a one-liner. Equally: do not gold-plate, do not expand scope, do not refactor beyond the diagnosed bug.

You can edit source. You can run tests, lint, typecheck, and format. You cannot commit, push, open a PR, or touch any GitHub state.

## Hard prohibitions

- No `git commit`. No `git push`. No `git tag`. No branch creation that survives. `git add` is allowed and expected at the end.
- No GitHub writes. Read-only `gh` reads only.
- No `curl` to arbitrary external hosts.
- Do not touch any issue other than the one being investigated.
- No `pnpm publish` or `npm publish`. No changeset commits (you may create a changeset file when a published package changed -- the orchestrator commits it).
- No drive-by edits. Touch only the files needed for the diagnosed bug and its test. If you see another problem in a nearby file, leave it for a human (AGENTS.md scope discipline rule).
- Do not modify Lingui catalogs (`packages/admin/src/locales/*/messages.po`). The extract workflow handles those on merge to `main`.

## Procedure

1. **Re-read the diagnose root cause.** That is your target. The fix should land in the file and approximate line diagnose named. If your work drifts to a different file, stop and reconsider -- diagnose may have been wrong, in which case the right answer is to abandon, not to wander.
2. **Establish a regression test where one is feasible.** Reproduce confirmed the bug through agent-browser, not a test, so there is usually no failing test on disk yet. If the bug is unit- or integration-testable (a handler, a query, a pure function, an API route), write a `vitest` test now that fails for the reported reason -- run it with `pnpm --filter <package> test <path>` and confirm it fails before you touch the fix. A bug with a testable surface and no regression test is not fixed. If the bug only manifests in the browser (admin UI interaction, rendered output), do not write a browser test -- the bot cannot run one reliably here; instead verify the fix through agent-browser and describe the manual verification in your notes so the maintainer can add a durable test when landing it.
3. **Implement diagnose's proposed fix -- the smallest change that fully resolves the bug.** Start from the plan diagnose gave you; the change should land in the file and approximate line it named. Follow EmDash's conventions:
   - Internal imports end with `.js`. Type-only imports use `import type`.
   - Routes that change state start with `export const prerender = false;`.
   - Never interpolate values into SQL. Use Kysely's `sql` tagged template; use `sql.ref()` for identifiers; validate dynamic identifiers with `validateIdentifier()` before any `sql.raw()`.
   - Handlers return `ApiResult<T>`. Errors use `apiError`, `handleError`, and `SCREAMING_SNAKE_CASE` error codes. Never expose `error.message` to clients.
   - Use `requirePerm` / `requireOwnerPerm` from `#api/authorize.js` for authorization. Permissions live in `packages/auth/src/rbac.ts` -- do not invent new permission strings inline.
   - Pagination returns `{ items, nextCursor? }`. Use `encodeCursor` / `decodeCursor`.
   - Content-table queries filter by `locale`.
   - Admin user-facing strings go through Lingui. Logical Tailwind classes only.
   - Use `import.meta.env.DEV`, never `process.env.NODE_ENV`.
   - Migrations are forward-only and additive. Register in `runner.ts` via `StaticMigrationProvider`.
   - Prefer additive changes. Breaking changes need an explicit changeset; do not introduce one for an automated fix without compelling justification.
4. **Run the reproduce test.** It must now pass. If it does not, your fix is wrong or incomplete. Investigate, adjust, or abandon -- do not weaken the test to make it pass.
5. **Run the broader test suite for the affected package.** `pnpm --filter <package> test`. Read the output. Any new failures in tests you did not write are regressions -- investigate and fix, or abandon the entire change. Do not push regressions through.
6. **Run typecheck.** `pnpm typecheck` for packages, `pnpm typecheck:demos` if a demo was involved. No new errors.
7. **Run lint quickly.** `pnpm lint:quick`. Snapshot the diagnostic count with `pnpm lint:json | jq '.diagnostics | length'` if the count looks suspicious -- a clean baseline should remain clean after your edits.
8. **Format.** `pnpm format`. The repo uses oxfmt with tabs; do not bypass it.
9. **Add a changeset when a published package changed.** Use the changeset CLI (`pnpm changeset`) non-interactively if possible, or create the file directly under `.changeset/`. Patch bump for a bug fix unless the diagnosis explicitly says otherwise. The summary should reference the issue number.
10. **Stage everything.** `git add -A`. Verify with `git status` that the staged set is what you expect -- source change, regression test, and changeset if applicable. Nothing else.
11. **Do not commit.** The orchestrator handles the commit, the branch, the push, and the PR. If you commit yourself you will desynchronise with the orchestrator and your work will likely be discarded.

## When to abandon

Return `fixed: false` with a clear explanation in notes when:

- The reproduce test does not actually fail before your change (diagnose or reproduce was wrong).
- Your fix introduces regressions you cannot resolve without scope-creep.
- The fix turns out to require breaking-change-level design decisions a human should make.
- Lint, typecheck, or format produces errors you cannot resolve cleanly.

A failed fix attempt is still useful -- the bot will post the diagnose and verify output and explain why the automated attempt was abandoned.

## Output

Return:

- Whether the fix succeeded.
- A conventional commit message the orchestrator can use: `fix(<scope>): <short description> (#<issue>)` for a fix, with the scope matching the package or area (`fix(core/menus)`, `fix(admin/seo)`, `fix(migrations)`).
- The list of file paths changed (relative to repo root).
- Whether the reproduce test currently passes against your staged changes.
- Notes: any context the maintainer should know -- design choices you made, alternatives you rejected, edge cases you considered, or, when `fixed: false`, the specific reason you abandoned.

The orchestrator reads this output, decides whether to commit, names the branch, opens the PR, and posts the triage comment that links to it.
