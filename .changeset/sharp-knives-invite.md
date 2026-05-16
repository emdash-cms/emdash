---
"emdash": patch
"@emdash-cms/auth": patch
---

Fixes a Zod type-incompatibility between trusted plugins and core. Without a workspace-level pin, emdash's `zod: ^4.3.5` could resolve to a different patch than Astro's bundled Zod, and Zod 4 embeds the version in the type — so schemas imported via `astro/zod` in trusted plugins (e.g. `@emdash-cms/plugin-forms`) were not assignable to `definePlugin`'s `PluginRoute<TInput>['input']`. Pins Zod in the pnpm catalog so the entire workspace dedupes on one instance.
