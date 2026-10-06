---
"emdash": patch
---

Fixes seed validation accepting reserved collection and field slugs, such as a field named `version`. `emdash seed --validate` and the check that runs before a seed is applied now report the reserved slug, instead of the seed passing validation and then failing while it is applied.
