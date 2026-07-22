---
"emdash": patch
---

Security: site secrets (`EMDASH_ENCRYPTION_KEY`, `EMDASH_PREVIEW_SECRET`, `EMDASH_IP_SALT`, and their legacy aliases) are no longer read through `import.meta.env`. In production builds Vite statically replaced that expression with the env loaded at build time, which embedded any secret present in `.env` on the build machine into the server bundle and made the stale build-time value silently shadow the real runtime secret (e.g. one set with `wrangler secret put`). The secrets module now reads only the runtime `process.env`. If you previously relied on a secret being baked in at build time, set it as a runtime secret/env var on your deployment platform instead — and rotate any key that shipped inside a bundle.
