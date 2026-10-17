---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds WebAuthn Signal API support so password managers stop offering passkeys that no longer work. In browsers that support the API:

- Opening **Settings > Security**, and removing a passkey there, sends the browser the complete list of the user's registered passkeys. The password manager hides any others for the site.
- Signing in with a passkey that is no longer registered asks the password manager to remove it, and the login page explains that the passkey was removed and how to sign in.
- Signing in updates the account name and display name the password manager shows for the user's passkeys.

`POST /_emdash/api/auth/passkey/verify` now returns the error code `CREDENTIAL_NOT_FOUND` for a passkey that is not registered, instead of `UNAUTHORIZED`. The status remains 401. `GET /_emdash/api/auth/passkey` adds `rpId` and `userHandle` to its response, and the admin package exports `fetchPasskeyList()` to read them.
