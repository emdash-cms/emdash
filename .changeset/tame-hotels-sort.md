---
"emdash": patch
---

Tightens conflict-error matchers in `handleContentCreate` and `handleContentUpdate`. Both paths now match specifically on `"unique constraint failed"` or `"duplicate key"` (avoiding false positives where the word "unique" appears in unrelated error text), and produce sanitized `SLUG_CONFLICT` / `CONFLICT` messages so raw database error text — including Postgres-internal index names — no longer leaks to API consumers. Clients that pattern-match the previous unsanitized messages will see normalized text instead.
