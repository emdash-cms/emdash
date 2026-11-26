---
"emdash": patch
"@emdash-cms/auth": minor
"@emdash-cms/auth-atproto": patch
---

Fixes setup getting stuck when the first admin is created through GitHub, Google, Microsoft, or AT Protocol sign-in but linking the sign-in account fails partway through. Signing in again with the same account now finishes setup; any other account is still refused.

`canSelfSignup`'s `createUser` function in `@emdash-cms/auth` now also receives the account being linked, as `createUser(user, account)`, and may return an existing user for `findOrCreateOAuthUser()` to link that account to.
