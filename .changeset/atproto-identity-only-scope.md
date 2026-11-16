---
"@emdash-cms/auth-atproto": patch
---

Fixes Atmosphere (AT Protocol) login requesting the broad `transition:generic` scope. EmDash now requests only `atproto`, so the PDS consent screen asks users to confirm their identity instead of granting app-password-level access to their account.

Handles and display names no longer depend on the user's PDS accepting the login token. EmDash reads the handle from the user's DID document and the display name from their public profile. A handle that doesn't resolve back to the user's DID is replaced by the DID.
