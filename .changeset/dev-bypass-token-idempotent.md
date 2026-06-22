---
"emdash": patch
---

Fixes the dev setup-bypass endpoint accumulating duplicate `dev-bypass-token` access tokens. Re-running it (for example after a dev reset) now replaces the previous token with a fresh one instead of adding another row.
