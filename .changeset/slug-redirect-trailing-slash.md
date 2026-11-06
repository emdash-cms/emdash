---
"emdash": patch
---

Fixes slug-change redirects for collections whose URL pattern ends in `/`, such as `/whats-on/{slug}/`. The automatic redirect now points to the URL with its trailing slash. When an entry's slug changes, existing redirects to or from its old and new URLs are matched with or without the trailing slash, so old URLs no longer take an extra hop and a redirect at the new URL no longer sends visitors away. When an entry is published at a URL that an automatic slug-change redirect still points away from, that redirect is now removed in either form.
