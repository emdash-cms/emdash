---
"emdash": patch
---

Fixes anonymous public page requests making a second database connection attempt after the setup check on a fresh server instance has already failed to reach the database. The request now skips CMS runtime initialization and renders without plugin-contributed metadata and page fragments, as it already did when runtime initialization failed. Later requests retry the check, and a server instance whose runtime is already running keeps using it.
