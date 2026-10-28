---
"emdash": patch
---

Fixes site builds using `zustand/traditional` or other dependencies that default-import `use-sync-external-store` shims, which previously failed with a missing default export error.
