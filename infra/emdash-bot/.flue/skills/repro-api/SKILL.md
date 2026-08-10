---
name: repro-api
description: Reproduce an EmDash bug below the browser layer -- REST handlers, CLI, MCP, migrations, schema registry, or build tooling. No browser. Prefer a failing vitest test in the affected package, run in an attached container.
---

# Reproduce: API / CLI / Migration / Build

The bug does not need a browser. It lives in a handler, the CLI, the MCP server, a migration, the schema registry, or the build pipeline. Your goal is a deterministic reproduction you can put in the comment as evidence -- ideally a failing vitest test that becomes the regression fixture once fixed.

## Environment

- **Read and search in the VFS.** Use `read_file`, `ls`, `grep`, and `code` to find the package, read the handler in full, and trace call sites. This is most of the work and none of it needs a container.
- **Attach a container only to run the project.** `pnpm install`, `pnpm build`, and `vitest` do not exist in the isolate. When you are ready to actually execute a reproduction, attach a container and run those there.

## Do not

- No `git commit`, `git push`, or branch creation. This stage never writes to the remote.
- No GitHub writes (no comments, labels, reactions). Read-only API GETs only.
- No network beyond the repo clone, the proxy-signed GitHub API, and the npm registry.
- No `pnpm publish` / `npm publish`.
- Touch no issue other than the one being investigated.

## Procedure

1. **Anchor on the issue's exact words.** In the isolate, pull the commands, file paths, package names, and stack traces out of the issue body verbatim. Your reproduction matches what the reporter wrote, not a paraphrase. If the body links a repo or gist, fetch it read-only before choosing an approach.
2. **Find the package (isolate).** Use `area` plus file paths in the body. CLI -> `packages/core/src/cli/`. REST handlers -> `packages/core/src/api/handlers/`. Migrations -> `packages/core/src/database/migrations/`. MCP -> `packages/core/src/mcp/`. Build -> `packages/*/tsdown.config.ts` or root `pnpm-workspace.yaml`. If several packages are plausible, `grep` before guessing. Read the candidate code fully in the isolate before you spend a container on it.
3. **Attach a container.** Everything from here needs one.
4. **Install only if needed.** The clone may already carry `node_modules` from the base image / R2 template artifact. If it does, skip the install. Run `pnpm install --frozen-lockfile --prefer-offline` only when `node_modules` is missing or you changed a manifest -- it is the slowest thing you can do.
5. **Build only what you must.** Most reproductions target source directly through vitest. Run `pnpm --filter <package> build` only when the bug is in compiled output or cross-package type generation.
6. **Choose an approach, in order of preference:**
   - **Failing vitest test** in the package's `tests/` tree. Use `setupTestDatabase()` / `setupForDialect()` from `tests/utils/test-db.ts` for anything touching the database; use the dialect wrapper (`describeEachDialect`) when the bug could be dialect-specific. Mirror source structure (`.../src/api/handlers/foo.ts` -> `.../tests/integration/api/handlers/foo.test.ts`). Name it for the issue: `it("reproduces #<number>: <short description>", ...)`. Run with `pnpm --filter <package> test <path>` and confirm it fails **for the reason reported**, not an unrelated setup error.
   - **Repro script** under `/tmp/repro-<issueNumber>/` when a test would need too much scaffolding (needs a built binary, needs to spawn children in a specific order). One file when possible; capture stdout, stderr, exit code.
   - **`pnpm exec emdash ...`** when the bug is a single CLI invocation whose failure is obvious from the output.
7. **Capture evidence.** For every attempt record the exact command, the meaningful slice of stdout/stderr (trim -- do not dump thousands of lines), and the exit code. This transcript is the deliverable.
8. **Confirm the failure mode matches.** A crash for a different reason is not a reproduction. If you can only trigger an adjacent failure, say so and lower confidence.

## When to skip

Mark skipped, with the reason, when the reproduction genuinely cannot happen here. Do not burn container time fighting these:

- Needs a WordPress export, customer dataset, or other artifact the reporter did not attach.
- Only manifests on a deployed Cloudflare Worker -- cold starts, eventual consistency, transient D1 errors, isolate eviction. A local run does not reproduce these faithfully.
- Needs Postgres at production scale (table sizes, pool exhaustion, planner choices). A handful of rows will not surface the same plan.
- Needs real Cloudflare Access, R2 credentials, AI Gateway routing, or other bindings the Workspace does not have.
- Timing-dependent heisenbug not reliably reproducible across runs. Note the symptom, leave it for a human.

## Output

Return:

- Whether you reproduced the bug.
- Whether you skipped, and the reason if so.
- The approach: `failing-test`, `repro-script`, `pnpm-command`, or `none`.
- Notes: the exact command(s), the failure output, and anything diagnose will need. Include the test file path if you wrote one.
- An empty screenshots list -- this skill produces none.

If you wrote a failing test, leave it in place; do not stage or commit it. A "could not reproduce" result with the full transcript of what you tried is a valid, useful outcome -- return it as one, not as silence.
