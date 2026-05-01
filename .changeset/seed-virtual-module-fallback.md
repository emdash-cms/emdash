---
"emdash": patch
---

Fixes the seed virtual module to also look at the conventional `seed/seed.json` path when no `.emdash/seed.json` or `package.json#emdash.seed` pointer is configured. Without this fallback, a site that only had `seed/seed.json` would silently fall through to the built-in default seed -- the setup wizard would not offer demo content, and the wrong schema would be applied. The loader now warns when it falls through to the default seed so misconfiguration is loud during dev.
