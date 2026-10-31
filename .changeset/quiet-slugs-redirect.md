---
"emdash": patch
---

Fixes automatic slug-change redirects being created for collections without a URL pattern. Slug changes skip redirect creation when the pattern is unset or empty, rather than guessing `/{collection}/{slug}` URLs that the site may not serve.

If your site relies on automatic redirects at `/{collection}/{slug}` with an unset pattern, set the collection's URL pattern explicitly (for example, `/posts/{slug}` for a `posts` collection) to keep automatic redirects on future slug changes. Sites with custom routing should set a pattern that matches their routes or add redirects for their actual public URLs manually. Existing redirect rules are not removed.
