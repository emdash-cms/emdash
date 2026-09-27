---
"emdash": patch
---

Removes the deprecated `emdash dev` and `emdash auth secret` CLI commands. Scripts that still call either command now exit with `Unknown command`.

- Replace `emdash dev` with the site's own dev script, such as `pnpm dev`, or run `astro dev` directly. The site then uses its configured database adapter instead of a local `./data.db`, which `emdash dev` created and migrated even on D1 sites. The `url` key under `emdash` in `package.json` was only read by `emdash dev --types` and can be deleted. To generate types from a remote instance, run `emdash types --url <site-url>`, or set `EMDASH_URL`.
- Remove `emdash auth secret` from scripts. New installations don't need `EMDASH_AUTH_SECRET`. Existing installations should keep the value they already have, since EmDash still reads it to keep commenter-IP hashes stable. To encrypt plugin secrets at rest, generate `EMDASH_ENCRYPTION_KEY` with `emdash secrets generate`.
