---
"@emdash-cms/admin": patch
---

Declare `@tiptap/extension-drag-handle`'s collaboration peer dependencies

`@emdash-cms/admin` uses `@tiptap/extension-drag-handle`, which declares `@tiptap/extension-collaboration`, `@tiptap/y-tiptap` (and transitively `yjs`, `y-protocols`) as peer dependencies. They were never installed because the collaboration feature is unused, and the admin bundle only worked because Rollup silently externalized the unresolved imports.

Astro 7 switches Vite to Rolldown, which fails the build on unresolved imports instead of externalizing them, so the admin build breaks on this chain. Declaring it fixes the build under Rolldown/Astro 7 — and is correct dependency hygiene regardless of bundler. Closes #1544.
