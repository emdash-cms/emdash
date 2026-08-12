---
name: implement
description: Implement a maintainer-directed EmDash enhancement or change without forcing it through bug-reproduction fields. Verify the change with authoritative checks and publish it through the trusted candidate publisher.
---

# Implement

A maintainer explicitly asked you to build the issue's requested change. Treat the issue body and directive as the specification. This lane is for enhancements and directed changes; do not invent a bug verdict or describe an enhancement as reproduced.

## Procedure

1. Read `AGENTS.md` and the relevant implementation, tests, and contributor guidance before editing.
2. Resolve ambiguity from existing APIs, sibling code, and backwards-compatible behavior. If a missing decision would materially change the public contract, stop and report it instead of guessing.
3. Edit through `edit_file` and `write_file`. Keep the change scoped to the request. Do not modify `.github/workflows` or generated Lingui catalogs.
4. Add behavior-level tests where the change has testable behavior. For a directed bug fix, follow the repository's failing-test-first rule.
5. Use `run_check` for every final verification. At minimum run the focused test and the repository-prescribed lint/typecheck commands that apply. Verification commands must not modify source files; apply formatting with `edit_file`/`write_file`, then run a check-only formatter command. Give checks stable names when rerunning them; publication requires every latest named result to pass.
6. Add a changeset when a published package changes. Write it as user-facing release notes.
7. Call `publish_candidate` with a conventional commit message. The trusted Worker owns Git objects and the `bot/fix-<issue>` ref; never run `git commit`, `git push`, or create a PR yourself.
8. Call `report_implementation` exactly once. Set `implemented: true` only after publication succeeds. Summarize the observable change and verification, not a bug verdict.

## Boundaries

- No direct GitHub writes, tags, package publication, or workflow edits.
- No source-modifying commands, output pipelines, or `|| true` on final checks. `run_check` rejects candidate mutations and status-masking commands.
- No edits after final verification. Publication requires every latest named check to match the exact candidate tree; rerun all required checks after any source change.
- No drive-by refactors or broad cleanup.
- Do not weaken a test to make it pass.

The candidate preview and draft-PR lifecycle remain owned by the orchestrator.
