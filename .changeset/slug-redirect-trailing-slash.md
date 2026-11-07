---
"emdash": patch
---

Fixes slug-change redirects for collections whose URL pattern ends in `/`, such as `/whats-on/{slug}/`. The automatic redirect now points to the URL with its trailing slash. When an entry's slug changes, existing redirects to or from its old and new URLs are matched with or without the trailing slash, so old URLs no longer take an extra hop and a redirect at the new URL no longer sends visitors away. Disabled redirects and 410 or 451 rules at the old URL are left unchanged, and the old URL keeps that rule instead of getting a new redirect. When an entry is published at a URL that an automatic slug-change redirect still points away from, that redirect is now removed in either form.
