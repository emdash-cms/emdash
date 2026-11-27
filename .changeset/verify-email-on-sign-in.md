---
"@emdash-cms/auth": patch
"emdash": patch
---

Fixes users staying unverified after they prove they own their email address. Signing in with an emailed magic link or recovery link now marks the address verified. So does signing in through, or linking, a GitHub, Google, or Microsoft account whose provider has verified the same address. Links from `createMagicLinkUrl()`, such as sign-in handover links, are not emailed, so using one does not verify the address.

The owner created through passkey setup now starts with a verified address, so comment notifications reach them.

Owners of existing sites who sign in only with a passkey stay unverified after upgrading, until they next sign in with a magic link, a recovery link, or a provider account. Signing in with a passkey does not verify an address.

Custom `AuthAdapter` implementations can add the optional `markEmailVerified(id, email)` method, which marks the address verified only if it still matches. Without it, EmDash falls back to `updateUser()`.
