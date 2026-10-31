---
"emdash": patch
---

Fixes `astro build --devOutput` for sites whose `registry` points at a plain-HTTP localhost aggregator. The build no longer fails with "must use HTTPS outside development"; a development-output build now accepts the same localhost registry URLs as `astro dev`. Production builds still reject them.
