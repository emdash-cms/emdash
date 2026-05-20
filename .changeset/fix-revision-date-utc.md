---
"@emdash-cms/admin": patch
---

Fixes admin timestamps shown in the wrong timezone on SQLite-backed sites. Stored timestamps without an explicit timezone are now parsed as UTC, so revision history and dashboard timestamps no longer drift by the viewer's offset.
