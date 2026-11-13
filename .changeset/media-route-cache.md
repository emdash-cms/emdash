---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": patch
---

Caches EmDash media in the route cache on sites with a cache provider. Whole image files from `/_emdash/api/media/file/` and resized variants from `/_image` are stored for one year under the tag `emdash:media:<storageKey>`. Replacing an image, or deleting one whose stored file is removed, purges that tag, so visitors get the new image (or a `404`) right away. This applies to deletes from the admin, the MCP `media_delete` tool and `ctx.media.delete()` in trusted and sandboxed plugins. Audio, video and range requests are not cached.

`/_image` URLs for EmDash media now redirect with a `301` when their query contains unknown or repeated parameters or lists them in a different order than Astro writes them. URLs built by `<Image>` and `getImage()` are unaffected.
