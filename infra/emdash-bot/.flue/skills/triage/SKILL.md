---
name: triage
description: Classify an issue, identify missing information, and decide whether bounded automatic work is safe.
---

# Triage an issue

Produce a useful first response without editing code or starting expensive verification. Read the issue, recent discussion, repository guidance, and the smallest relevant source area.

Use `auto-work` only when the expected behaviour is unambiguous, the cause and change are localized, and the task does not require a product, compatibility, security, migration, dependency, release, or CI decision. Automatic work must still reproduce a reported bug when practical and pass the normal candidate verification.

Use `needs-info` when the reporter can supply a specific missing fact that determines whether or how the issue reproduces. Ask the smallest number of concrete questions in the summary.

Use `await-approval` for deeper investigations, design choices, risky areas, likely duplicates, apparently resolved reports, or any task whose scope may expand. State what was established and what the next run would do. Do not close the issue or claim a duplicate as certain.

Return:

- `disposition`: `auto-work`, `needs-info`, or `await-approval`.
- `kind`: `bug`, `enhancement`, or `task`.
- `labels`: existing repository labels that materially improve classification, such as an `area/*` label. Do not invent labels or include lifecycle labels.
- `summary`: evidence, missing information, or the proposed next step in plain language for the reporter and maintainer.

Call `report_triage` exactly once. Do not edit files, attach a container, publish a candidate, or call another report tool.
