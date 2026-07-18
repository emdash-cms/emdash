---
"@emdash-cms/registry-moderation": minor
---

Blocks releases labeled `hateful-imagery`, `explicit-imagery`, or `graphic-violence` -- these automated-block labels were issuable by the labeler but silently ignored by release evaluation and enforcement, leaving a policy-blocked release installable. Also recognizes the `content-warning` label as a non-blocking warning, and exposes the `AUTOMATED_BLOCKS` and `WARNINGS` label-value sets for consumers that classify labels directly.
