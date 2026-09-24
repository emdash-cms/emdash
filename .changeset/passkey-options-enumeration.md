---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes passkey sign-in options revealing whether an email address has an account. `POST /_emdash/api/auth/passkey/options` now ignores the optional `email` field and returns the same options for every request, so the browser offers any passkey saved for the site. The default admin login is unaffected. Clients that posted `email` to this endpoint to sign in with passkeys not stored on the authenticator (non-discoverable credentials, such as some older security keys) can no longer sign in with those keys. Register a passkey on an authenticator that supports discoverable credentials (most platform authenticators and current security keys), or sign in with a magic link or a configured OAuth provider. The `@emdash-cms/admin` `PasskeyLogin` component's `showEmailInput` prop is deprecated and no longer shows an email field; existing callers still type-check and can drop the prop. The previous email-scoped behavior cannot be restored.
