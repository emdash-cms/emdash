---
"emdash": patch
---

Fixes draft publication of a reference field from undoing link changes published from the opposite end of the relation in the meantime.

Draft reference changes now merge with concurrent changes from either end of the relation. Additions and removals made in the draft take effect, while links changed only from the opposite end remain unchanged. Restoring a revision continues to replace the live selection exactly.
