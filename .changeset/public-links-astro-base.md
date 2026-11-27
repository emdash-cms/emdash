---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes links into the public site on sites that set Astro's `base` (for example `/blog`). These links now include the base instead of 404ing:

- Preview links from the admin and the preview URL API, when they come from the collection's URL pattern or the default `/{collection}/{id}` path. A `pathPattern` in the request or `EMDASH_PREVIEW_PATH_PATTERN` is still used exactly as given.
- Menu items that point to content, taxonomy terms, and collection archives. Custom menu URLs are unchanged.
- The admin's View Site, Live View, View published, and calendar View live links.
- Links inserted with the editor's link picker.
- URLs returned by the plugin content API's `getPublicUrl()`.

If you added your base to a collection's URL pattern to work around this, remove it after upgrading, or the base will appear twice in these links.
