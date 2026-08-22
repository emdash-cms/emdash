---
name: implement
description: Implement a maintainer-directed EmDash enhancement or change without forcing it through bug-reproduction fields. Run focused checks, publish the candidate, and report the results accurately.
---

# Implement

A maintainer explicitly asked you to build the issue's requested change. Treat the issue body and directive as the specification. This lane is for enhancements and directed changes; do not invent a bug verdict or describe an enhancement as reproduced.

## Delivery priorities

The working candidate is the deliverable; tests are evidence for it. TDD controls ordering for a confirmed bug, not how much of the run test construction may consume. Enhancements do not need a failing test first.

- Use an existing test file, helper, and configuration at the lowest layer that proves the requested behavior. One focused regression case is normally enough.
- Do not add a test configuration, package script, custom harness, or dependency inspection solely to make the change testable. Do not inspect `node_modules` unless the requested behavior depends on third-party internals.
- If one test approach has not converged after three attempts or about ten minutes, stop using it. Choose a lower-level seam or implement the scoped change and report the test gap. For a confirmed bug, do not claim completion without a meaningful regression test; publish the partial candidate and state what is missing.
- Protect the final fifteen minutes for metadata, one verification pass, `publish_candidate`, and reporting. Stop optional investigation before that window.
- Update the public plan after the first source edit and when moving from editing to verification or publication. Do not leave it on an obsolete test step.

## Procedure

1. Read `AGENTS.md` and the relevant implementation, tests, and contributor guidance before editing.
2. The harness installs dependencies and builds the base workspace before this turn. Do not run `pnpm install`, the root `pnpm build`, or a pre-edit lint baseline.
3. Choose the smallest final verification set before editing: the focused behavior test, affected package tests and typechecks, final lint, and a check-only formatter. Do not plan a monorepo-wide test suite when focused or package-level checks cover the changed behavior.
4. Resolve ambiguity from existing APIs, sibling code, and backwards-compatible behavior. If a missing decision would materially change the public contract, stop and report it instead of guessing.
5. Edit through `edit_file` and `write_file`. Keep the change scoped to the request. Do not modify `.github/workflows` or generated Lingui catalogs.
6. Add the smallest behavior-level test that uses existing infrastructure. For a directed bug fix, follow the repository's failing-test-first rule within the test-construction limit above.
7. Finish every candidate edit before final verification. Apply formatting and add the changeset now, when a published package changed. Follow `.changeset/README.md`: write public CHANGELOG documentation with detail proportional to the impact, not a diff summary.
8. Run the planned final checks with `exec`, once each on the final candidate. Fix failures caused by the change and rerun the affected check after editing. Do not hide failures with shell fallbacks. If a relevant failure remains, preserve the candidate and report it accurately instead of withholding the work from CI.
9. Call `publish_candidate` after the final checks, including when a check remains failing. The trusted tool commits and pushes only to `bot/fix-<issue>` through the issue-scoped Git proxy; never run `git commit`, `git push`, or create a PR yourself.
10. Call `report_implementation` exactly once. Set `implemented: true` only after publication succeeds. Summarize the observable change and verification, not a bug verdict.

## Verification scope

- Prefer the focused regression test and affected package checks. Run a broader root check once only when the change crosses its surface or `AGENTS.md` explicitly requires it.
- Treat install and the initial workspace build as bootstrap, not verification. Reuse them for the whole run and across resume when the saved container is still available.
- Treat all coordinated edits for one change as one edit round. Do not run lint, typecheck, and tests after each individual file edit.
- If a broad final check fails only in untouched files, report it and use the narrow authoritative check for your files. Never repair unrelated failures.
- If a broad suite times out, do not immediately run it again. Run the smallest relevant subsets, report the omitted or timed-out suite, and preserve time for publication and reporting.
- Verification commands must not modify source files. Use `edit_file` or `write_file` before the final pass, then use check-only formatter commands.

## Finalization and resume

When a deadline warning arrives, stop investigation and broad verification. Do not start a check that could consume the remaining window. Run only short missing checks from the existing plan, then publish and report. If relevant verification cannot finish, report the useful partial outcome instead of starting another long command.

After a resume, use the saved checkpoint and candidate. Complete listed metadata such as a missing changeset before checks, then make one final verification pass. Do not reopen settled design work, repeat a timed-out broad suite, or investigate unrelated failures.

## Boundaries

- No direct GitHub writes, tags, package publication, or workflow edits.
- No source-modifying commands or `|| true` on final checks. Apply source changes with `edit_file` or `write_file`.
- If you edit after a check, rerun the checks affected by that edit before publication.
- No drive-by refactors or broad cleanup.
- Do not weaken a test to make it pass.

The candidate preview and draft-PR lifecycle remain owned by the orchestrator.
