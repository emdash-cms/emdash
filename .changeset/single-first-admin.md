---
"emdash": patch
"@emdash-cms/auth": minor
"@emdash-cms/auth-atproto": patch
---

Fixes first-admin creation so only one person becomes admin when several first sign-ins happen at the same moment.

- **GitHub, Google, Microsoft, and AT Protocol sign-in during setup:** the first sign-in becomes admin. A sign-in that finishes at the same time is now refused with `signup_not_allowed` instead of creating a second admin. With AT Protocol, only the account that becomes admin receives the email entered in the setup wizard, so another account can no longer be linked to the admin by that email.
- **Cloudflare Access:** when several people sign in to a new site at once, one becomes admin and the others get the role from their Access groups.

While setup is still open, a sign-in from a new identity is refused once any user exists, matching the passkey setup step.

`@emdash-cms/auth` adds an optional `createUser(user)` function to `canSelfSignup` results. When present, `findOrCreateOAuthUser()` calls it instead of `adapter.createUser()`. If it returns `null`, the sign-in is refused with `signup_not_allowed`.

`@emdash-cms/auth-atproto` now requires `emdash` 1.7.0 or later.
