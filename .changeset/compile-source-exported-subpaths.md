---
"emdash": patch
---

Fixes spurious TypeScript errors in strict projects that consume EmDash. Several subpaths (`emdash/routes/*`, `emdash/api/route-utils`, `emdash/api/schemas`, `emdash/auth/providers/*`) previously shipped raw source, so your `tsc` and editor type-checked EmDash's internals against your config and could report errors that weren't yours. These now ship compiled type declarations instead. Import paths and runtime behaviour are unchanged.
