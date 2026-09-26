---
"emdash": patch
---

Fixes type errors when registering native plugins whose options are declared as an interface, such as `formsPlugin()`, `embedsPlugin()`, and plugins scaffolded by `emdash plugin init --native`. A type-checked `astro.config.mjs` (for example, one checked by `astro check`) no longer reports TS2322 for these `plugins` entries. Plugin options must still be an object.
