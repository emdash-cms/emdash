---
"emdash": minor
"@emdash-cms/auth": minor
---

Adds support for accepting passkey assertions from multiple origins that share an `rpId`. Set `EMDASH_ALLOWED_ORIGINS` (comma-separated) alongside `EMDASH_SITE_URL` to verify passkeys originating from preview/staging subdomains under the same registrable parent domain — previously, the strict origin check rejected them. `PasskeyConfig.origin: string` is replaced by `PasskeyConfig.origins: string[]`; `getPasskeyConfig()` accepts an optional `allowedOrigins` array as its 4th argument.
