---
"emdash": patch
---

Fixes invite passkey registration behind a TLS-terminating reverse proxy. The invite `register-options` endpoint now resolves the public origin via `getPublicOrigin(url, emdash.config)` before calling `getPasskeyConfig`, matching every other passkey endpoint. Previously the WebAuthn RP ID fell back to `url.hostname` (e.g. `localhost`), causing the browser to reject the registration with "Security error" when the public origin differed from the upstream host.
