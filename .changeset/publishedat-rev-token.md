---
"@emdash-cms/admin": patch
---

Fixes an entry's publication date saving without a warning when someone else changed the entry after the editor loaded it. The date change is now refused like any other save based on a stale read, and the editor shows its conflict notice with the option to save over the newer version.
