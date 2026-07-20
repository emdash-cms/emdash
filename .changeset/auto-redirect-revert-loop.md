---
"emdash": patch
---

Fixes a circular redirect loop when a slug rename is reverted. Renaming a slug back to a previous value now removes the stale redirect that shadowed the restored URL, so the page stays reachable.
