---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes entry slugs keeping accidental spaces, which published entries at URLs such as `/my-post%20%20/`. When an entry is created or its slug changes, whitespace at either end of the slug is removed, and each run of whitespace inside it, together with any hyphens beside it, becomes one hyphen: `" my post "` and `"my - post"` both become `"my-post"`. This applies whether the change comes from the admin, MCP or the REST API. Drafts, scheduled entries and revisions saved by an earlier release are cleaned the same way when they are published or restored. The admin's Slug field shows the cleaned slug as soon as you leave it.

Existing slugs are kept as stored, so saving an entry without changing its slug never moves its URL.

#### What should I do?

- To fix a URL that already has spaces, open the entry, retype its slug (trailing spaces are invisible in the field), and save or publish the change. Once the new slug is live, EmDash redirects the old URL to it.
- If an integration creates entries through the REST API or MCP with spaces in the slug and later looks them up by that slug, look them up by the cleaned slug instead.
