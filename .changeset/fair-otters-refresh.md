---
"@emdash-cms/plugin-cli": patch
---

Fixes saved OAuth sessions failing to refresh or revoke after the original loopback callback server closes. New logins retain the loopback client registration needed to recreate the same OAuth client.

Sessions created before this fix do not contain that registration metadata and cannot be resumed. Sign in again after upgrading.
