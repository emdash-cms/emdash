---
"emdash": patch
---

Fixes redirect loop detection never finishing when a pattern redirect's destination is matched again by a pattern redirect, such as `/[...path]` → `/moved/[...path]`. Listing redirects, saving a redirect, or analyzing a site package with such a rule ran until the server ran out of memory. Such a chain now counts as a loop: the Redirects page flags the rule, a site import writes it disabled, and a new redirect that leads into the chain is refused. A chain through more than 20 pattern redirects is treated the same way, since browsers stop following redirects after 20.
