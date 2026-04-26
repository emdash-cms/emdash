---
"emdash": patch
---

Fixes paginated list endpoints silently returning the first page when given a malformed cursor. Bad cursors now produce a structured `INVALID_CURSOR` error so client pagination bugs surface immediately.
