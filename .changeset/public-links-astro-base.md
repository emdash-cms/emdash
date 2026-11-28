---
"emdash": patch
"@emdash-cms/admin": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes links into the public site on sites that set Astro's `base` (for example `/blog`). These links now include the base instead of 404ing:

- Preview links from the admin and the preview URL API, when they come from the collection's URL pattern or the default `/{collection}/{id}` path. A `pathPattern` in the request or `EMDASH_PREVIEW_PATH_PATTERN` is still used exactly as given.
- Menu items that point to content, taxonomy terms, and collection archives. Custom menu URLs are unchanged.
- The admin's View Site, Live View, View published, and calendar View live links.
- Links you insert with the editor's link picker from now on. Links already saved in your content keep their old paths.
- URLs returned by the plugin content API's `getPublicUrl()`, for trusted and sandboxed plugins.

If you worked around this, remove the workaround after upgrading, or the base will appear twice:

- A base written into a collection's URL pattern.
- A template that puts the base in front of `item.url` from `getMenu()`.
- A plugin that adds the base to what `getPublicUrl()` returns.
