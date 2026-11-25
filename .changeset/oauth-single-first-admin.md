---
"emdash": patch
"@emdash-cms/auth": patch
---

Fixes GitHub, Google, and Microsoft sign-in during setup so only one account becomes the first admin when two people finish signing in at the same moment. The later sign-in is now refused with `signup_not_allowed`, and no second account is created.

`canSelfSignup` results in `@emdash-cms/auth` can now include an optional `createUser` function, which `findOrCreateOAuthUser()` uses in place of `adapter.createUser()`. It refuses the signup by returning `null`.
