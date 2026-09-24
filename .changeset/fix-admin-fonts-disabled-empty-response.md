---
"emdash": patch
---

Fixes every admin page (including login and the setup wizard) returning an empty response when `fonts: false` is set in the `emdash()` integration config. The admin now falls back to system fonts.
