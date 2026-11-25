---
"emdash": patch
---

Fixes redirect loop detection never finishing when a pattern redirect's destination is matched again by a pattern redirect, such as `/[...path]` → `/moved/[...path]` or `/[...path]` → `/[...path]/[...path]`. Listing redirects, saving a redirect, or analyzing a site package with such a rule ran until the server ran out of memory. Such a chain now counts as a loop: the Redirects page flags the rule, a site import writes it disabled, and a new redirect that leads into the chain is refused. A chain through more than 20 pattern redirects, or one that grows a path past 8,192 characters, is treated the same way.

Saving a redirect whose source has percent-encoded brackets, such as `/posts/%5Bslug%5D`, is no longer refused as a loop when its destination leads through other redirects to a path that the source would match as a pattern.
