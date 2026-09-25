---
"emdash": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes Workerd plugins retaining access after they are disabled or unloaded, and keeps capabilities, allowed hosts, and storage declarations scoped to the loaded plugin version. Re-enabling a plugin issues fresh credentials.
