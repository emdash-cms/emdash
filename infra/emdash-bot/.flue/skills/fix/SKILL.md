---
name: fix
description: Implement diagnose's proposed fix when verify says bug, the cause is pinned, and a maintainer triggered a fix. Follow EmDash conventions, run focused checks, publish the candidate, and report the results accurately.
---

# Fix

You are here because a maintainer issued a **fix** directive, verify returned `bug`, diagnose pinned the cause with at least `medium` confidence, and diagnose rated the fix `mechanical` or `clear-best-option`. Diagnose handed you a **proposed fix** -- a concrete plan naming the file and the change. Implement that plan, prove it works, and leave the change verified. The hard reasoning is done; do not re-litigate the diagnosis unless reading the code convinces you it is wrong (then abandon -- see below).

**What your output is, and is not.** You are not merging and not opening a PR. The trusted `publish_candidate` tool commits and pushes your change to the issue's `bot/fix-<n>` candidate branch through an issue-scoped Git proxy; that triggers a **preview build** the workflow posts to the issue. **Only after the reporter confirms** does a draft PR open, and a maintainer reviews before anything reaches `main`. The target is a correct, conventions-respecting change that makes the repro test pass. Publish a useful candidate even when a check remains failing, and report the failure accurately so CI and the maintainer can assess it. Do not gold-plate, expand scope, or refactor beyond the diagnosed bug.

## Delivery priorities

The working candidate is the deliverable; the regression test is focused evidence. TDD controls ordering, not how much of the run test construction may consume.

- Reuse reproduce's evidence and the repository's existing test infrastructure. One focused case at the lowest layer that proves the same defect is enough.
- Do not add a test configuration, package script, custom harness, or dependency investigation solely to reproduce the bug. Do not inspect `node_modules` unless diagnose identified third-party behavior as the cause.
- If the regression test has not converged after three attempts or about ten minutes, the test is at the wrong layer. Switch to a smaller seam. If no meaningful regression test fits existing infrastructure, publish the partial candidate, report the gap, and do not claim the bug fixed.
- Protect the final fifteen minutes for metadata, one verification pass, `publish_candidate`, and reporting. Stop optional investigation before that window.
- Update the public plan after the first source edit and when moving from editing to verification or publication. Do not leave it on an obsolete test step.

## Environment

- **Edit in the VFS** with the `edit_file` / `write_file` tools; read surrounding code with `read_file` and `grep`. Every VFS edit is replayed onto the container checkout before each container command.
- **Run tests, lint, typecheck, and format checks with `exec`** -- none of the toolchain exists in the VFS. Run each planned final check once and report its real exit status.

## Do not

- No `git commit`, `git push`, `git tag`, or PR creation. `publish_candidate` owns the issue's candidate branch. The workflow owns the preview and the PR.
- No GitHub writes. Read-only API GETs only.
- No network beyond the clone, the proxy-signed GitHub API, and the npm registry.
- No `pnpm publish` / `npm publish`.
- No drive-by edits. Touch only the files the diagnosed bug and its test need. A problem in a nearby file is a human's -- scope discipline.
- Do not modify Lingui catalogs (`packages/admin/src/locales/*/messages.po`); the extract workflow handles them on merge.
- If you edit after a check, rerun the checks affected by that edit before publication.

## Procedure

1. **Re-read diagnose's root cause and proposed fix.** That is your target and your spec. The change should land in the file and approximate line diagnose named. If your work drifts to a different file, stop -- diagnose may be wrong, in which case abandon, do not wander.
2. **Use the prepared workspace.** The harness installs dependencies and builds the base workspace before this turn. Do not run `pnpm install`, the root `pnpm build`, or a pre-edit lint baseline.
3. **Choose the final verification set.** Plan the focused repro test, affected package tests and typechecks, final lint, and a check-only formatter. Use the smallest checks that cover the behavior. Do not plan a monorepo-wide suite when focused or package-level checks are authoritative.
4. **Establish one focused regression test where feasible.** Reproduce usually confirmed the bug without a test on disk. If the bug is unit- or integration-testable through existing infrastructure (a handler, a query, a pure function, an API route), write a `vitest` test that fails for the reported reason, and confirm it fails in the container (`pnpm --filter <package> test <path>`) _before_ you touch the fix. A testable bug with no regression test is not fixed. If the bug only manifests in the browser (admin interaction, rendered output), do not write a browser test -- you cannot run one reliably here; verify through `agent-browser` instead and describe that manual verification so the maintainer can add a durable test when landing.
5. **Implement the proposed fix -- the smallest change that fully resolves the bug.** Follow EmDash conventions:
   - Internal imports end `.js`; type-only imports use `import type`.
   - State-changing routes start with `export const prerender = false;`.
   - Never interpolate values into SQL: Kysely `sql` tagged template for values, `sql.ref()` for identifiers, `validateIdentifier()` before any `sql.raw()`.
   - Handlers return `ApiResult<T>`; errors use `apiError` / `handleError` with `SCREAMING_SNAKE_CASE` codes; never expose `error.message` to clients.
   - Authorization via `requirePerm` / `requireOwnerPerm` from `#api/authorize.js`; permissions live in `packages/auth/src/rbac.ts` -- do not invent strings inline.
   - Pagination returns `{ items, nextCursor? }` via `encodeCursor` / `decodeCursor`.
   - Content-table queries filter by `locale`.
   - Admin strings go through Lingui; logical Tailwind classes only.
   - `import.meta.env.DEV`, never `process.env.NODE_ENV`.
   - Migrations are forward-only and additive; register in `runner.ts` via `StaticMigrationProvider`.
   - Prefer additive changes. A breaking change needs an explicit changeset -- do not introduce one for an automated fix without compelling justification.
6. **Finish the candidate tree.** Apply formatting and add the changeset now, when a published package changed. Follow `.changeset/README.md`: write public CHANGELOG documentation with detail proportional to the impact, not a diff summary.
7. **Run one final verification pass with `exec`.** Run the focused repro test first, then the remaining planned checks. Run each check once on the final tree; do not repeat a passing check on an unchanged tree or hide a failure with a shell fallback.
8. **Respond to relevant failures only.** Fix a regression in touched behavior or abandon the change. If you edit the candidate, rerun the planned set once on the new tree. Never edit unrelated files to make a broad lint, typecheck, or test command pass.
9. **Publish with `publish_candidate` after the final checks, including when a check remains failing.** Do not reproduce its work with shell commands. Report `fixed: true` only after publication succeeds, and include every remaining verification failure in the summary.

## Efficient verification

- Treat coordinated edits across several files as one edit round. Do not run lint, typecheck, and tests after each individual file.
- Treat install and the initial workspace build as bootstrap, not verification. Reuse them for the whole run and across resume when the saved container is still available.
- Prefer affected package checks. Run a broader root check once only when the change crosses its surface or `AGENTS.md` explicitly requires it.
- If an affected package suite is known to exceed the remaining budget or has already timed out, do not repeat it. Run the focused relevant subsets, report the omitted suite, and preserve time to publish and report.
- Verification commands must not modify source files. Apply formatting before the final pass, then use a check-only formatter command.

## Finalization and resume

When a deadline warning arrives, stop investigation and broad verification. Do not start another package or root suite. Run only short missing checks from the existing plan, then publish and report. If relevant verification cannot finish, report the useful partial outcome instead of consuming the window with another long command.

After a resume, follow the saved checkpoint's remaining-work list. Complete metadata such as a missing changeset before checks, then run one final verification pass. Do not reopen the diagnosis, repeat a timed-out broad suite, or investigate unrelated failures.

## When to abandon

Return not-fixed, with a clear reason, when:

- The repro test does not actually fail before your change (diagnose or reproduce was wrong).
- Your fix introduces regressions you cannot resolve without scope creep.
- The fix turns out to need breaking-change-level design decisions a human should make.
- Lint, typecheck, or format produces errors you cannot resolve cleanly.

A failed attempt is still useful -- the bot posts the diagnose and verify output and explains why the automated fix was abandoned.

## Output

Return:

- Whether the fix succeeded.
- The conventional-commit message you used: `fix(<scope>): <short description> (#<issue>)`, scope matching the package or area (`fix(core/menus)`, `fix(admin/seo)`, `fix(migrations)`).
- The list of changed file paths, repo-root-relative.
- Whether the repro test currently passes against your change -- with the command and its output as evidence.
- Notes: design choices, rejected alternatives, edge cases, or (when not fixed) the specific reason you abandoned.

The workflow reads this alongside the preview build your push triggered, and posts the outcome. It does not open a PR until the reporter confirms the preview fixes their case.
