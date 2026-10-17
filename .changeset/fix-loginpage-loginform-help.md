---
"@emdash-cms/admin": patch
"@emdash-cms/auth-atproto": patch
"emdash": patch
---

Fixes the admin login page so the help text under a provider's `LoginForm` is no longer hard-coded to "Enter your handle to sign in." for every provider.

Providers can now export an optional `loginHelp` string or component from their admin entry. When `loginHelp` is absent, the page falls back to a neutral "Continue with {label}." message.

The built-in AT Protocol provider exports its existing handle-specific help text so Atmosphere logins keep the same prompt.
