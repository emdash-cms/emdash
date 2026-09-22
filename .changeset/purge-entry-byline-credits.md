---
"emdash": patch
---

Fixes permanently deleting an entry leaving its byline credits in the database, where a seed that re-creates a slugless entry under the same ID picked them up. Credits left behind by entries deleted before this release are not removed.
