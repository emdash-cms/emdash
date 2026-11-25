---
"emdash": patch
---

Fixes new automatic slug-change redirects on sites with an Astro `base`, so the old URL returns a 301 to the new URL under the same base path. Existing rules and manually entered redirect paths are unchanged; edit any previously generated base-free rules to include the base in both paths.
