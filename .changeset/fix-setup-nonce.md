---
"emdash": patch
---

Fixes a setup-window admin hijack by binding `/setup/admin` and `/setup/admin/verify` to a per-session nonce cookie. Previously an unauthenticated attacker who could reach a site during first-time setup could POST to `/setup/admin` between the legitimate admin's email submission and passkey verification, overwriting the stored email — the admin account would then be created with the attacker's address. The admin route now mints a cryptographically random nonce, stores it in setup state, and sets it as an HttpOnly, SameSite=Strict, `/_emdash/`-scoped cookie; the verify route rejects any request whose cookie does not match in constant time.
