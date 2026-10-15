---
"emdash": patch
---

Fixes `emdash whoami` failing on sites behind Cloudflare Access: it now sends the headers from `--header` and `EMDASH_HEADERS` and reads `EMDASH_URL`, like the other commands. Without a token on localhost, it now signs in through the dev bypass and reports the dev user, and exits 1 when no site answers or the site isn't running under `astro dev`, so scripts can use it as a reachability check.
