---
"emdash": patch
---

Warns during `astro build` and `astro dev` when the installed `@emdash-cms/cloudflare` version differs from `emdash`. The adapter depends on the exact `emdash` version it was released with, so upgrading only one of the two packages installs a second copy of `emdash` that the adapter runs against. The warning names both versions and the command to install matching ones.
