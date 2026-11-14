---
"emdash": patch
---

Fixes `emdash types` typing blocks fields as `unknown[]`. The generated `.emdash/types.ts` now types each blocks field as the union of its block types, with every retained version, matching the `emdash-env.d.ts` the dev server writes. The site that `emdash types` connects to generates the types, so a site you reach with `--url` needs this release before the output changes.
