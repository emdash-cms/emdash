---
"emdash": patch
---

Fixes the media table filling up with hidden, unusable `pending` records — one per upload attempt — when storage cannot create signed upload URLs, which is always the case for local storage and for R2 accessed through a Worker binding.
