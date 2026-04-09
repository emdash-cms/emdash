---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/plugin-atproto": minor
"@emdash-cms/auth": patch
---

Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.
