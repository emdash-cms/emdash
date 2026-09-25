---
"emdash": patch
---

Fixes the inline Portable Text editor failing to load in visual editing under `astro dev` on sites installed with pnpm, along with the `Failed to resolve dependency` warnings for `lowlight`, `highlight.js`, and `highlight.js/lib/core` that `astro dev` and `astro build` printed on those sites.
