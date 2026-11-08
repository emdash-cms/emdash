---
"emdash": patch
---

Fixes sites using an `objectCache` backend serving the previous version of an entry after a content update under concurrent read load, where the stale entry could keep being served until the next write to the same collection or until the cache TTL expired.
