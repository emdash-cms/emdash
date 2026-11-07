---
title: Cache media files in the route cache
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: https://github.com/emdash-cms/emdash/discussions/3159
created: 2026-11-07
---

# Cache media files in the route cache

## Problem and user case

Every uploaded image is served from `/_emdash/api/media/file/<key>`, and every resized variant from `/_image?href=/_emdash/api/media/file/<key>&w=...`. Both answer with `Cache-Control: public, max-age=0, must-revalidate` and set no route-cache intent. On Cloudflare, Workers Cache never stores them (`cf-cache-status: BYPASS`), so each image view runs the Worker, reads R2 and, for a variant, calls the Images binding again. On Node with `memoryCache()`, each view reads storage again.

The short lifetime has a reason. **Replace** in the media library (`PUT /_emdash/api/media/{id}/replace`, also used by cropping) writes the new file under the same storage key. With a longer lifetime, visitors would keep seeing the old image, and nothing purges it today.

Sites pay for this on every image request, although replacing an original is rare. Issue [#4498](https://github.com/emdash-cms/emdash/issues/4498) reports it for original files, issue [#4214](https://github.com/emdash-cms/emdash/issues/4214) for resized variants that are transformed again for every new visitor, and [Discussion #3159](https://github.com/emdash-cms/emdash/discussions/3159) describes both. The reporter of #4498 works around it in a custom Worker entry that adds CDN headers and purges on replace.

## Proposed behavior

When the site configures an Astro cache provider (`cacheCloudflare()`, `memoryCache()` or another adapter's provider), EmDash stores image responses in the route cache and purges them when the image changes:

- A whole `200` image response from the media file route, and every successful variant from the image endpoints (Node and the Cloudflare Images binding), calls `context.cache.set({ maxAge: 86400, tags: ["emdash:media:<storageKey>"] })`.
- A successful replace invalidates `emdash:media:<storageKey>`. One purge removes the original file and every cached variant of it.
- A successful delete that removed the stored file invalidates the same tag, so a deleted image stops being served from the cache.
- The `Cache-Control` header that browsers see stays `public, max-age=0, must-revalidate` with the existing `ETag` and `Last-Modified` validators. Browser caches can't be purged, so a replaced image must still revalidate there. Revalidation still returns `304` when the image is unchanged.
- Without a cache provider, nothing changes.

A prototype ran on a throwaway Cloudflare Worker with its own D1 database and R2 bucket, using a 1.4 MB PNG and `cacheCloudflare()`. The requests came from one client and were few, so the numbers are indicative:

| Request                            | EmDash 1.4.0                       | Prototype                                                                              |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Original file, repeated            | `BYPASS` every time, 150 to 230 ms | `HIT`, 45 to 130 ms                                                                    |
| `/_image` variant, `w=400`, WebP   | not measured                       | first `MISS` 350 ms, then `HIT` 45 to 55 ms; `If-None-Match` returns `304`             |
| After replace                      |                                    | immediate `MISS` with the new bytes (checked by MD5), then `HIT`; same for the variant |
| After delete                       |                                    | `404` for the file and the variant                                                     |
| `Range` request for a cached image |                                    | `206` with the requested bytes                                                         |

The baseline numbers come from a different image on a different Worker (our stock demo site). On Node with `memoryCache()`, the prototype showed the same hit, replace and delete behavior for original files. The prototype is commit [`aa90da5`](https://github.com/swissky/emdash/commit/aa90da512) on the fork branch [`proto/4498-media-edge-cache`](https://github.com/swissky/emdash/tree/proto/4498-media-edge-cache).

## Goals

- Repeated views of an image or a resized variant are served from the configured route cache.
- New visitors see a replaced image as soon as the purge succeeds.
- A deleted image stops being served as soon as the purge succeeds.
- Logged-out requests run no additional database queries. A cache hit runs none.

## Non-goals

- Caching audio, video and other non-image files. See [Errors and edge cases](#errors-and-edge-cases).
- Changing the browser `Cache-Control`, or making file URLs content-addressed (a new storage key or a version parameter on replace). That rewrites stored references in content and is a larger change.
- Media from external providers, or storage served from a public URL. Those responses don't pass through these routes.
- Limiting which widths, formats or qualities `/_image` accepts. Issue #4214 asks for that too; it is a separate decision.
- A configuration option for the lifetime.

## Interfaces and compatibility

- No public API, configuration or stored data changes.
- Sites with a cache provider get a behavior change: image responses are cached for up to one day and carry the tag `emdash:media:<storageKey>`. The tag is namespaced, so tags that sites already purge are unaffected.
- The route caching guide says that changes to the media library invalidate nothing. It will describe the media tag and which actions purge it. Cached pages are still not purged by media changes, because replace keeps the image URL. The pending plan for manual cache invalidation ([#4587](https://github.com/emdash-cms/emdash/pull/4587)) quotes that sentence about pages, so the two plans don't conflict.
- Ships as a minor release with a changeset for `emdash` and `@emdash-cms/cloudflare`.

## Errors and edge cases

- **Failed or rate-limited purge.** `invalidateRouteCache` logs and never throws, so a replace or delete still succeeds when the purge fails. Workers Cache rate-limits purge requests, and the editor doesn't see a rejected purge. The old or deleted image then stays cached until `maxAge` expires, at most one day.
- **Range requests.** `memoryCache()` keys entries by URL and ignores the `Range` header, so a cached file answers a ranged request with the whole file and status `200`. The prototype reproduced this on Node. Video and audio players depend on ranges, so only `image/*` responses are stored. Audio and video stay uncached until this is solved separately.
- **Responses that are never stored:** `206`, `304`, `404`, `416` and error responses. Only whole `200` image responses and successful variants call `cache.set`.
- **Deletes outside the media routes.** Media deleted through the plugin API (`ctx.media.delete`) or the MCP `media_delete` tool, and storage objects removed directly, are not purged. Those images stay cached until `maxAge`. New uploads get unique storage keys, so they never collide with a cached key.
- **Private keys.** The media file route refuses backup and transfer staging keys before it reads storage. Refused keys return `404` and are never cached.

## Verification

- Media file route: a whole image `200` sets the route cache with the tag and `maxAge`; a ranged request, a `304`, a `404` and a non-image file do not.
- Image endpoints on Node and Cloudflare: a successful variant sets the same tag; a failed transform does not.
- Replace: a successful replace invalidates the tag; a failed upload or metadata update does not. A rejected purge doesn't fail the replace.
- Delete: invalidates the tag when the stored file was removed, not when the media item doesn't exist.
- Without a cache provider, responses and headers are unchanged.
- Logged-out query counts don't increase (`pnpm query-counts`).
- Manual check on Cloudflare with `cacheCloudflare()`: `BYPASS` before, `HIT` after; replace and delete take effect immediately for the file and a variant.

## Open questions

- Is one day the right lifetime, given that a failed purge leaves an old or deleted image visible that long?
- Should deletes through the plugin API and the MCP tool purge the tag in this plan, or in a follow-up?
