---
"emdash": minor
---

Adds `where: { status?, locale? }` to `ContentListOptions`, letting plugins narrow `ContentAccess.list()` results at the database layer instead of filtering the returned array. The underlying repository already supports these filters — this PR only exposes them through the plugin-facing type.
