---
"emdash": patch
---

Fixes `emdash/ui`, `emdash/ui/search`, `emdash/ui/comments`, and `emdash/ui/webmcp-search` imports so TypeScript uses package declarations instead of checking EmDash source under your project's compiler settings, including when using Astro's TypeScript content mapper. Astro continues to compile the components from source when building your site.

Plain `tsc` now checks component props, including required props and `Blocks` renderer types. Calls that previously relied on loosely typed `.astro` imports may report invalid props after upgrading.
