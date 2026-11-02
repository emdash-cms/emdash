---
"emdash": patch
---

Fixes OAuth sign-in on Node adapters ignoring provider credentials (`EMDASH_OAUTH_*` and provider `*_CLIENT_ID`, `*_CLIENT_SECRET` and `*_TENANT_ID` values) set at runtime, for example with container environment variables. Sign-in failed with `provider_not_configured` unless the credentials were also present when the site was built, and credentials present at build time were written into the server bundle.

On Node, OAuth credentials must now be in the server's process environment at runtime; values baked in from `.env` at build time are no longer used. If you only set them in a `.env` file, load it when starting the server (for example `node --env-file=.env ./dist/server/entry.mjs`) or set them in your host's environment; otherwise sign-in fails with `provider_not_configured`. `astro dev` still falls back to `.env`. If your server build output was shared or stored, rotate any client secret that was present at build time.
