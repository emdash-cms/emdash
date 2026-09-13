---
"emdash": patch
---

Fixes non-translatable fields never reaching an entry's other translations on collections with revisions, which is the default. Publishing an entry now copies the non-translatable values it changed to the rest of its translation group, and a save that started from a translation's earlier version gets a conflict instead of overwriting the copied values. Values that already differ between translations stay as they are until a change to that field is published in one of them.
