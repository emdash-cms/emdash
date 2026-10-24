---
"@emdash-cms/auth": patch
---

Fixes passkeys that registered successfully but could never be used to sign in. Passkey sign-in lets the browser offer any passkey for the site, which only works with discoverable credentials, so registration now requires one (`residentKey: "required"`). Authenticators that cannot store a discoverable credential, such as older U2F-only security keys or keys with no free slots, now fail at registration with an error instead of creating a passkey that is never offered at sign-in.
