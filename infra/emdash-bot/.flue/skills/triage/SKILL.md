---
name: triage
description: Classify an issue, identify missing information, and decide whether bounded automatic work is safe.
---

# Triage an issue

Produce a useful first response without editing code or starting expensive verification. Read the issue, recent discussion, repository guidance, and the smallest relevant source area.

Use `auto-work` for a bug when the report gives a clear expected and actual behaviour and the work can proceed without a product, compatibility, security, migration, dependency, release, or CI decision. Triage does not need to prove the cause or know the final patch: the work run reproduces the report, diagnoses it, verifies the expected behaviour, and abandons unsafe fixes. Prefer spending agent work over asking a maintainer to approve routine investigation.

Use `needs-info` when the reporter can supply a specific missing fact that determines whether or how the issue reproduces. Ask the smallest number of concrete questions in the summary.

Use `await-approval` for enhancements and tasks without a maintainer-approved specification, design choices, risky areas, likely duplicates, apparently resolved reports, or work that requires one of the decisions above. Do not use it merely because a bug needs deeper investigation. State what was established and what the next run would do. Do not close the issue or claim a duplicate as certain.

Return:

- `disposition`: `auto-work`, `needs-info`, or `await-approval`.
- `kind`: `bug`, `enhancement`, or `task`.
- `labels`: existing repository labels that materially improve classification, such as an `area/*` label. Do not invent labels or include lifecycle labels.
- `summary`: evidence, missing information, or the proposed next step in plain language for the reporter and maintainer.

Call `report_triage` exactly once. Do not edit files, attach a container, publish a candidate, or call another report tool.
