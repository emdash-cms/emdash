---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": patch
---

Caches EmDash media in the route cache on sites with a cache provider. Whole image files from `/_emdash/api/media/file/` and resized variants from `/_image` are stored for one year under the tag `emdash:media:<storageKey>`. Replacing an image, or deleting one whose stored file is removed, purges that tag, so visitors get the new image (or a `404`) right away. This applies to deletes from the admin media library and media picker, the MCP `media_delete` tool and `ctx.media.delete()` in plugin routes. Audio, video and range requests are not cached.

With Astro's `memoryCache()` on Node, only media responses up to 10 MB are cached, and cached images count toward the provider's 1,000-entry limit together with your pages. Each process keeps its own copy, so sites running several processes keep serving a replaced or deleted image from the processes that didn't handle the change. See [Media files](https://docs.emdashcms.com/deployment/route-caching/#media-files) for the deletes that are not purged.

`/_image` URLs for EmDash media now redirect with a `301` when their query contains unknown or repeated parameters or lists them in a different order than Astro writes them. URLs built by `<Image>` and `getImage()` are unaffected.
