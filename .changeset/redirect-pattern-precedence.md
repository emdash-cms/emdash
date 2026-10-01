---
"emdash": patch
---

Fixes redirect pattern precedence when several enabled pattern rules match the same path. The earliest-created rule now always wins. Previously the winner depended on database row order, which could change after a rule was edited or hit, particularly on PostgreSQL.
