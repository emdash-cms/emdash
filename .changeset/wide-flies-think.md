---
"emdash": patch
---

Fixes cold-start query explosion (159 -> ~25 queries) by short-circuiting migrations when all are applied, fixing FTS triggers to exclude soft-deleted content, and preventing false-positive FTS index rebuilds on every startup.
