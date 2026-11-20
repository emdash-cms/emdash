---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/auth-atproto": patch
---

Fixes the Users page showing “Last Login: Never” after magic-link, OAuth (including AT Protocol), or external-provider sign-in. Successful sign-ins now record a login time independently of passkeys, while existing passkey login history remains visible. Previously unrecorded logins appear after the next sign-in; refreshing an existing session does not record a new login.

EmDash migrates the database automatically. Existing standalone Kysely auth-adapter databases continue to report passkey history without requiring a schema change.
