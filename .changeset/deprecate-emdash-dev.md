---
"emdash": patch
---

Deprecates `emdash dev` and hides it from CLI help. Existing invocations still work, but now warn you to use the project's `dev` script, such as `pnpm dev`, or run `astro dev` directly.
