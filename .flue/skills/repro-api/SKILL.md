---
name: repro-api
description: Reproduce an EmDash bug that lives below the browser layer -- REST handlers, CLI, MCP, migrations, schema registry, or build tooling. No agent-browser. Prefer a failing vitest test in the affected package.
---

# Reproduce: API / CLI / Migration / Build

The issue you are reproducing does not need a browser. It is in a handler, the CLI, the MCP server, a migration, the schema registry, or the build pipeline. Your goal is a deterministic local reproduction the bot can describe in a comment, ideally as a failing vitest test that becomes the regression fixture once the bug is fixed.

## Hard prohibitions

- No `git commit`, no `git push`, no branch creation that survives the workflow.
- No writes to GitHub (no `gh issue comment`, `gh pr ...`, `gh issue edit`).
- No `curl` to arbitrary external hosts. Local processes only.
- Do not touch any issue other than the one being investigated.
- No `pnpm publish` or `npm publish`.

## Procedure

1. **Re-read the issue body.** Pull out the exact commands, file paths, package names, and stack traces. The reproduction you write should match the user's words, not a paraphrase of them. If the body links to a repo or gist, fetch it (read-only) before deciding on the approach.
2. **Identify the package.** Use `area` plus any file paths in the issue body. CLI bugs live in `packages/core/src/cli/`. REST handlers in `packages/core/src/api/handlers/`. Migrations in `packages/core/src/database/migrations/`. Build tooling typically in `packages/*/tsdown.config.ts` or the root `pnpm-workspace.yaml`. MCP in `packages/core/src/mcp/`. If multiple packages are plausible, search with `grep` before guessing.
3. **Install if needed.** If `node_modules` looks stale or missing, run `pnpm install`. Otherwise skip it -- installs are slow and the runner usually has the deps already.
4. **Build only what you must.** Most reproductions can target source directly via vitest. Only run `pnpm --filter <package> build` if the bug is in compiled output or in cross-package type generation.
5. **Choose an approach.** In order of preference:
   - **Failing vitest test** in the affected package's `tests/` directory. Use `setupTestDatabase()` / `setupForDialect()` from `tests/utils/test-db.ts` for anything that touches the database. Mirror the source structure (`packages/core/src/api/handlers/foo.ts` -> `packages/core/tests/integration/api/handlers/foo.test.ts`). Name the test for the issue: `it("reproduces #<number>: <short description>", ...)`. Run it with `pnpm --filter <package> test <path>` and confirm it fails for the reason the user reported, not for an unrelated setup error.
   - **Repro script** under `/tmp/repro-<issueNumber>/` when a vitest test would need too much scaffolding (e.g. needs a built CLI binary, needs to spawn child processes in a specific order). Keep it to a single file when possible. Capture stdout, stderr, and exit code.
   - **`pnpm exec emdash ...` command** when the bug is a single CLI invocation and the failure is obvious from the output.
6. **Capture evidence.** For each attempt, record the exact command, the relevant stdout/stderr (trim to the meaningful slice -- do not dump thousands of lines), and the exit code.
7. **Confirm the failure mode matches.** A reproduction that crashes for a different reason than the user reported is not a reproduction. If you can only trigger an adjacent failure, say so in notes and lower your confidence in the result.

## When to skip

Mark `skipped: true` and explain in notes when any of the following apply. Do not burn runner minutes trying to work around these.

- The bug requires a specific WordPress export file, customer dataset, or other artifact the user did not attach.
- The bug only manifests on a deployed Cloudflare Worker -- cold starts, eventual consistency, transient D1 errors, Worker isolate eviction. Local `wrangler dev` does not reproduce these faithfully.
- The bug requires Postgres at production scale (table sizes, connection pool exhaustion, planner choices). A handful of rows in `pg` will not surface the same plan.
- The bug requires real Cloudflare Access, R2 credentials, AI Gateway routing, or other bindings that the runner does not have.
- The bug is timing-dependent in a way that is not reliably reproducible across runs (heisenbug). Note the symptom, leave it for a human.

## Output

Return:

- Whether you reproduced the bug.
- Whether you skipped (with reason if so).
- The approach you used: `failing-test`, `repro-script`, `pnpm-command`, or `none`.
- Notes: a short paragraph with the exact command(s), the failure output, and any context the diagnose stage will need. Include the test file path if you wrote one.
- An empty screenshots list. This skill does not produce screenshots.

If you wrote a failing test, leave it in place. Do not stage or commit it. The fix stage may pick it up; if no fix runs, the orchestrator decides what to do with the working tree.
