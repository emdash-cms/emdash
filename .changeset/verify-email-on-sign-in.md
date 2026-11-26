---
"@emdash-cms/auth": patch
---

Fixes users staying unverified after they prove they own their email address, which stopped comment notifications from reaching them. Users created through passkey setup start with an unverified address. Signing in with an emailed magic link or recovery link now marks the address verified. So does signing in through, or linking, a GitHub, Google, or Microsoft account whose provider has verified the same address. Links from `createMagicLinkUrl()`, such as sign-in handover links, are not emailed, so using one does not verify the address.
