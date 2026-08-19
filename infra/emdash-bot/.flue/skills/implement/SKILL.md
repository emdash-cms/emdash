---
name: implement
description: Implement a maintainer-directed EmDash enhancement or change without forcing it through bug-reproduction fields. Verify the change with authoritative checks and publish it through the trusted candidate publisher.
---

# Implement

A maintainer explicitly asked you to build the issue's requested change. Treat the issue body and directive as the specification. This lane is for enhancements and directed changes; do not invent a bug verdict or describe an enhancement as reproduced.

## Procedure

1. Read `AGENTS.md` and the relevant implementation, tests, and contributor guidance before editing.
2. The harness installs dependencies and builds the base workspace before this turn. Do not run `pnpm install`, the root `pnpm build`, or a pre-edit lint baseline.
3. Choose the smallest authoritative final verification set before editing: the focused behavior test, affected package tests and typechecks, final lint, and a check-only formatter. Do not plan a monorepo-wide test suite when focused or package-level checks cover the changed behavior.
4. Resolve ambiguity from existing APIs, sibling code, and backwards-compatible behavior. If a missing decision would materially change the public contract, stop and report it instead of guessing.
5. Edit through `edit_file` and `write_file`. Keep the change scoped to the request. Do not modify `.github/workflows` or generated Lingui catalogs.
6. Add behavior-level tests where the change has testable behavior. For a directed bug fix, follow the repository's failing-test-first rule.
7. Finish every candidate edit before final verification. Apply formatting and add the changeset now, when a published package changed. Follow `.changeset/README.md`: write public CHANGELOG documentation with detail proportional to the impact, not a diff summary. The changeset is part of the candidate tree, so adding it after checks would invalidate every result.
8. Run the planned final checks through `run_check`. Use stable names and run each check once on the final candidate tree. A check name is permanently bound to its first command, including flags and arguments; if you need a different command, choose a new name before running it. If a relevant check fails and you edit the candidate, rerun the planned set once on the new tree with the original names and commands. Do not repeat a passing check on an unchanged tree.
9. Call `publish_candidate` as soon as the planned checks pass. The trusted Worker owns Git objects and the `bot/fix-<issue>` ref; never run `git commit`, `git push`, or create a PR yourself.
10. Call `report_implementation` exactly once. Set `implemented: true` only after publication succeeds. Summarize the observable change and verification, not a bug verdict.

## Verification scope

- Prefer the focused regression test and affected package checks. Run a broader root check once only when the change crosses its surface or `AGENTS.md` explicitly requires it.
- Treat install and the initial workspace build as bootstrap, not verification. Reuse them for the whole run and across resume when the saved container is still available.
- Treat all coordinated edits for one change as one edit round. Do not run lint, typecheck, and tests after each individual file edit.
- If a broad final check fails only in untouched files, report it and use the narrow authoritative check for your files. Never repair unrelated failures or register a predictably failing broad command as a final `run_check`.
- If a broad suite times out, do not immediately run it again. Run the smallest relevant subsets, report the omitted or timed-out suite, and preserve time for publication and reporting.
- If `run_check` reports that a name is already bound, choose a new name for the different command. The rejected command did not modify verification state; do not retry it under the bound name.
- Verification commands must not modify source files. Use `edit_file` or `write_file` before the final pass, then use check-only formatter commands.

## Finalization and resume

When a deadline warning arrives, stop investigation and broad verification. Do not start a check that could consume the remaining window. Run only short missing checks from the existing plan, then publish and report. If relevant verification cannot finish, report the useful partial outcome instead of starting another long command.

After a resume, use the saved checkpoint, candidate, and verification evidence. Complete listed metadata such as a missing changeset before checks, then make one final verification pass. Do not reopen settled design work, repeat a timed-out broad suite, or investigate unrelated failures.

## Boundaries

- No direct GitHub writes, tags, package publication, or workflow edits.
- No source-modifying commands, output pipelines, or `|| true` on final checks. `run_check` rejects candidate mutations and status-masking commands.
- No edits after final verification. Publication requires every latest named check to match the exact candidate tree.
- No drive-by refactors or broad cleanup.
- Do not weaken a test to make it pass.

The candidate preview and draft-PR lifecycle remain owned by the orchestrator.
