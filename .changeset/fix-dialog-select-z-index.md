---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes select dropdown appearing behind dialog by removing explicit z-index values and adding `isolate` to the admin body for proper stacking context.
