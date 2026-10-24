---
"@emdash-cms/auth": patch
"emdash": patch
---

Fixes **Settings > Security** labelling every passkey as device-bound. EmDash now records whether a passkey is synced by its password manager when it is registered, and updates the record each time the passkey is used to sign in, so existing passkeys show the correct label after their next sign-in. Registration and sign-in now reject an authenticator response that reports a backup without backup eligibility, as the WebAuthn specification requires.

Custom `AuthAdapter` implementations receive the backup state as an optional third argument to `updateCredentialCounter()`. Adapters that ignore it keep working.
