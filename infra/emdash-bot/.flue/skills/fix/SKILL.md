---
name: fix
description: Implement diagnose's proposed fix when verify says bug, the cause is pinned, and a maintainer triggered a fix. Follow EmDash conventions, prove the repro test passes, run lint and typecheck, and leave a verified candidate for the preview-build loop.
---

# Fix

You are here because a maintainer issued a **fix** directive, verify returned `bug`, diagnose pinned the cause with at least `medium` confidence, and diagnose rated the fix `mechanical` or `clear-best-option`. Diagnose handed you a **proposed fix** -- a concrete plan naming the file and the change. Implement that plan, prove it works, and leave the change verified. The hard reasoning is done; do not re-litigate the diagnosis unless reading the code convinces you it is wrong (then abandon -- see below).

**What your output is, and is not.** You are not merging and not opening a PR. The trusted `publish_candidate` tool publishes your change to the issue's `bot/fix-<n>` candidate branch; that triggers a **preview build** the workflow posts to the issue. **Only after the reporter confirms** does a draft PR open, and a maintainer reviews before anything reaches `main`. So the bar is "a correct, conventions-respecting change that makes the repro test pass" -- not "a perfect, unimprovable patch." A clear, test-backed fix is worth shipping for verification even when it is more than a one-liner. Equally: do not gold-plate, do not expand scope, do not refactor beyond the diagnosed bug.

## Environment

- **Edit in the VFS** with the `edit_file` / `write_file` tools; read surrounding code with `read_file` and `grep`. Every VFS edit is replayed onto the container checkout before each container command.
- **Run final tests, lint, typecheck, and format checks through `run_check`** -- none of the toolchain exists in the VFS. Verification commands must not modify source files. Apply formatting with `edit_file`/`write_file`, then use a check-only formatter command. Use `exec` only for exploratory commands whose result is not a release gate.

## Do not

- No `git commit`, `git push`, `git tag`, or PR creation. `publish_candidate` owns the issue's candidate branch. The workflow owns the preview and the PR.
- No GitHub writes. Read-only API GETs only.
- No network beyond the clone, the proxy-signed GitHub API, and the npm registry.
- No `pnpm publish` / `npm publish`.
- No drive-by edits. Touch only the files the diagnosed bug and its test need. A problem in a nearby file is a human's -- scope discipline.
- Do not modify Lingui catalogs (`packages/admin/src/locales/*/messages.po`); the extract workflow handles them on merge.
- Do not edit after final verification. Publication requires every latest named `run_check` result to match the exact candidate tree; rerun all required checks after any source change.

## Procedure

1. **Re-read diagnose's root cause and proposed fix.** That is your target and your spec. The change should land in the file and approximate line diagnose named. If your work drifts to a different file, stop -- diagnose may be wrong, in which case abandon, do not wander.
2. **Establish a regression test where feasible.** Reproduce usually confirmed the bug without a test on disk. If the bug is unit- or integration-testable (a handler, a query, a pure function, an API route), write a `vitest` test now that fails for the reported reason, and confirm it fails in the container (`pnpm --filter <package> test <path>`) _before_ you touch the fix. A testable bug with no regression test is not fixed. If the bug only manifests in the browser (admin interaction, rendered output), do not write a browser test -- you cannot run one reliably here; verify through `agent-browser` instead and describe that manual verification so the maintainer can add a durable test when landing.
3. **Implement the proposed fix -- the smallest change that fully resolves the bug.** Follow EmDash conventions:
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
4. **Run the repro test with `run_check`.** It must now pass. If not, your fix is wrong or incomplete -- investigate, adjust, or abandon. Never weaken the test to make it pass.
5. **Run the affected package's suite with `run_check`.** `pnpm --filter <package> test`. New failures in tests you did not write are regressions -- fix them or abandon the whole change.
6. **Typecheck with `run_check`.** `pnpm typecheck` for packages, `pnpm typecheck:demos` if a demo was involved. No new errors.
7. **Lint with `run_check`.** Run `pnpm lint:quick`; a clean baseline stays clean.
8. **Check formatting with `run_check`.** Apply any needed formatting with `edit_file`/`write_file`, then run `pnpm format:check` or the narrow check-only formatter command appropriate to the files you touched. Do not bulk-format unrelated files.
9. **Add a changeset when a published package changed.** Create the file under `.changeset/` (patch bump for a bug fix unless diagnosis says otherwise). Write it as release notes for someone upgrading -- lead with a verb, describe the observable effect, reference the issue -- not as a commit message. Include it in your fix commit.
10. **Publish with `publish_candidate`.** Do not reproduce its work with shell commands. Report `fixed: true` only after it succeeds.

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
