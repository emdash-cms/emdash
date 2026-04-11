---
"@emdash-cms/auth": minor
"emdash": minor
"@emdash-cms/admin": minor
---

Adds TOTP (authenticator app) authentication as an alternative to passkeys for both first-run admin setup and ongoing login. Works with any RFC 6238 authenticator and requires no email backend, so it's available on a fresh install. Includes 10 single-use recovery codes, 10-failure lockout, replay protection, and an `astro.config.mjs` disable flag. Requires `EMDASH_AUTH_SECRET` to be set (base64url, 32+ chars). **Breaking** for third-party `AuthAdapter` implementers: four new required methods (`getTOTPByUserId`, `createTOTP`, `updateTOTP`, `deleteTOTP`). See discussion #432.
