---
"emdash": patch
---

Fixes spurious TypeScript errors in strict projects that consume EmDash. Several subpaths (`emdash/routes/*`, `emdash/api/route-utils`, `emdash/api/schemas`, `emdash/auth/providers/github`, `emdash/auth/providers/google`) previously shipped raw source, so your `tsc` and editor type-checked EmDash's internals against your config and could report errors that weren't yours. These now ship compiled type declarations instead. The `*-admin` providers and `emdash/ui` stay source because they bridge the admin React/Astro runtime your own build processes. Import paths and runtime behaviour are unchanged.
