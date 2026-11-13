---
"@emdash-cms/auth-atproto": patch
---

Fixes Atmosphere (AT Protocol) login requesting the broad `transition:generic` scope. EmDash now requests only `atproto`, so the PDS consent screen asks to confirm the user's identity instead of granting app-password-level access to their account.
