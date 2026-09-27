---
"emdash": patch
---

Hardens redirect rules, including rules stored without going through the admin API:

- The redirect middleware now only redirects to site-relative paths that start with a single `/`. It skips any rule whose destination has a scheme, starts with `//` or `/\`, or contains control characters, and logs a warning with the rule's ID.
- Pattern sources treat parentheses and other regex characters as literal text. Previously a source such as `/(.*.*.*x)/[slug]` compiled into a regex that could stall requests, and one with an unbalanced `(` stopped every redirect on the site from working.
- Fixes pattern rules that put a `[param]` before a `[...splat]`, such as `/[category]/[...rest]`, which swapped the two captured values.
- Stored pattern rules whose source is malformed (for example, `/[a][b][c]`) are skipped with a warning instead of being compiled.
- Seed files now get the same redirect checks as the redirects API. Validation fails when a pattern source is malformed, a destination uses a placeholder the source doesn't capture, or a destination would resolve to another site.
