---
"@emdash-cms/admin": patch
---

Fixes admin `?field=` links, including those opened from the visual-editing toolbar, so paths such as `?field=layout.{blockKey}.title` open the collapsed block and focus the requested field. For a list item, use its zero-based index, for example `?field=layout.{blockKey}.items.1.description`. Links to publication dates, bylines, slugs, and SEO now focus the corresponding settings controls, opening the settings panel on mobile when needed.
