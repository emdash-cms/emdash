---
"emdash": patch
---

Fixes redirect patterns so literal text is matched exactly. Characters such as `(`, `)`, `|`, `[` and `]` outside a `[param]` or `[...rest]` placeholder were passed through to the underlying regular expression, so a pattern like `/[x]/(a|aa)(a|aa)…` could take seconds to evaluate against a crafted request path, and `(a|b)` behaved as alternation rather than matching the text `(a|b)`. Patterns that used these characters as undocumented regular-expression syntax now match them literally; split any intentional alternation into a separate redirect for each alternative.

Also fixes patterns where a `[param]` comes before a `[...rest]`: the two placeholders no longer receive each other's values, so `/[category]/[...rest]` → `/blog/[category]/[...rest]` now redirects `/tech/2024/post` to `/blog/tech/2024/post`.
