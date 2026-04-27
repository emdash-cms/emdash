---
"emdash": patch
---

Fixes paginated list endpoints silently returning the first page when given a malformed cursor. Bad cursors now produce a structured `INVALID_CURSOR` error so client pagination bugs surface immediately.

**Note for plugin authors:** the low-level `decodeCursor` export from `emdash/database/repositories` now throws `InvalidCursorError` on invalid input instead of returning `null`. Direct callers (rare — most code uses `findMany`-style helpers that handle this internally) should wrap the call in `try`/`catch` or migrate to the higher-level helpers.
