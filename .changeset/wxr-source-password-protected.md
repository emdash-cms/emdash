---
"emdash": patch
---

Fixes the exported `wxrSource` import source treating password-protected WordPress posts as published. Such posts now have the status `private`, so they import as drafts, as they do in the admin and CLI WordPress importers, and they are left out when `includeDrafts` is false.
