---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": patch
---

Caches EmDash image files for one year on sites with a compatible route-cache provider, such as `cacheCloudflare()`. Original files from `/_emdash/api/media/file/` and eligible resized variants from `/_image` share the tag `emdash:media:<storageKey>`. Replacing an image, or deleting one whose stored file is removed, purges that tag. Deletes from the admin media library and media picker, the MCP `media_delete` tool and `ctx.media.delete()` in plugin routes are covered, subject to the [purge limitations](https://docs.emdashcms.com/deployment/route-caching/#media-files).

Astro's `memoryCache()` does not receive automatic media cache entries at any response size; page caching is unaffected. Other providers must preserve distinct source URLs and transform options in their cache keys and support conditional requests. Audio, video, partial responses and original-file URLs with query strings are not stored. Variants are eligible only when their `href` is a plain EmDash media path or that path prefixed with the request's origin, without a nested query or fragment.

Automatic variant caching and query normalization apply only to Astro's stock sharp service on Node and `@astrojs/cloudflare/image-service-workerd` on Cloudflare. With these services, `/_image` URLs for EmDash media redirect with a `301` when their outer query contains unknown or repeated parameters, uses a different parameter order or encodes values differently. This also applies without a cache provider. Stock-service URLs built by `<Image>` and `getImage()` are unaffected. Custom image services retain their existing handling and parameters without these redirects or automatic variant caching.
