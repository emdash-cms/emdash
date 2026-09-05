---
"emdash": patch
---

Fixes `emdash export-seed` so its progress line goes to stderr and kysely's `orderBy` deprecation notice is no longer triggered, allowing `emdash export-seed > seed.json` to write a file that parses as JSON. Previously the redirected file began with `ℹ Database: …` and `orderBy(array) is deprecated…`, the command still exited `0` with an empty stderr, and the corruption surfaced only when `emdash seed` rejected the file at restore time.
