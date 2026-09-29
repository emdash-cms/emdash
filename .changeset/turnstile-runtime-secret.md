---
"emdash": patch
---

Fixes comment Turnstile verification ignoring `EMDASH_TURNSTILE_SECRET_KEY` and `TURNSTILE_SECRET_KEY` when they are set at runtime, for example with `wrangler secret put` or container environment variables. Comment submissions were accepted without a Turnstile check unless the key was also present when the site was built, and a key present at build time was written into the server bundle.

On Node, the key must now be in the server's process environment at runtime. If you only set it in a `.env` file, load it when starting the server (for example `node --env-file=.env ./dist/server/entry.mjs`) or set it in your host's environment; otherwise comments are accepted without a Turnstile check. If your server build output was shared or stored, rotate a key that was present at build time.
