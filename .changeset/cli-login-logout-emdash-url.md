---
"emdash": patch
---

Fixes `emdash login` and `emdash logout` ignoring `EMDASH_URL`. Without `--url`, they now use the site in `EMDASH_URL`, like the other commands, instead of always going to `http://localhost:4321`.
