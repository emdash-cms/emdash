---
name: work
description: Deliver one maintainer-approved EmDash issue, choosing the bug-fix path for a defect and the direct implementation path for an enhancement or task.
---

# Work on an approved issue

A maintainer approved this issue for delivery. Classify the requested work before editing, then use the matching path below. The `work` command replaces the old choice between `fix` and `implement`; the issue type determines the method and result fields.

## Bug path

For a reported defect:

1. Reproduce the reported behavior with the smallest meaningful failing test or browser journey.
2. Diagnose the defect in the current source and verify that the proposed behavior is correct.
3. Add the regression test before the fix, implement the smallest backwards-compatible correction, and rerun the focused test.
4. Set `fixed: true` only after `publish_candidate` succeeds. Report the reproduction and verification evidence.

If reporter-only information prevents a reproduction attempt, report `verdict: "unclear"` and ask for that specific information. If the behavior is intended or the fix needs a product, security, migration, or breaking-change decision, do not edit. Report the evidence and decision needed.

## Enhancement or task path

For approved new behavior, documentation, maintenance, or another directed task:

1. Treat the issue and maintainer directive as the specification. Resolve details from existing APIs and conventions without inventing a bug verdict.
2. Implement the smallest complete change and add focused behavior coverage through existing test infrastructure.
3. Run the affected checks and publish the candidate even if a relevant check still fails after a reasonable repair attempt.
4. Set `implemented: true` only after `publish_candidate` succeeds. Report the observable change and exact verification results.

## Shared constraints

- Read `AGENTS.md` and the relevant implementation and tests before editing.
- Use `edit_file` or `write_file` for direct edits. Use `exec` for local Git operations, generators, formatters, tests, builds, and conflict resolution; shell writes are checkpointed into the durable workspace.
- Do not edit `.github/workflows`, push from the execution container, or perform unrelated cleanup.
- Add a changeset when a published package changes. Keep user-facing documentation useful to someone adopting the change.
- Use `fixed` for a bug or `implemented` for an enhancement/task. Never set both.
- Run one final focused verification pass after the last edit, then call `publish_candidate` and `report_result` exactly once.
