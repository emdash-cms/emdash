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

- A whole `200` image response from the media file route, and every successful variant from the image endpoints (Node and the Cloudflare Images binding), calls `context.cache.set({ maxAge: 31536000, tags: ["emdash:media:<storageKey>"] })`. The lifetime is one year because the purge, not the expiry, keeps the cache correct.
- Variant URLs for EmDash media are normalized before anything is transformed. The canonical query holds the parameters Astro's `getURL` writes, in its order (`href`, `w`, `h`, `q`, `f`, `fit`, `position`, `background`), each at most once, followed by the adapter's `assetQueryParams`. A request whose query differs from its canonical form (unknown parameters, a repeated parameter, another order) gets a `301` to the canonical URL. A repeated parameter keeps the value the endpoint uses today, the first one, so the redirect target renders the same image. URLs built by `<Image>` and `getImage()` are already canonical and never redirect. Only canonical requests are cached, so extra or reordered parameters can't create new cache entries.
- A successful replace invalidates `emdash:media:<storageKey>`. One purge removes the original file and every cached variant of it.
- A successful delete that removed the stored file invalidates the same tag, so a deleted image stops being served from the cache. This covers the media routes, the MCP `media_delete` tool and `ctx.media.delete` in plugins.
- The `Cache-Control` header that browsers see stays `public, max-age=0, must-revalidate` with the existing `ETag` and `Last-Modified` validators. Browser caches can't be purged, so a replaced image must still revalidate there. Revalidation still returns `304` when the image is unchanged.
- Without a cache provider, nothing is cached. Non-canonical variant URLs still redirect, so a URL behaves the same with or without a provider.

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
- A deleted image stops being served as soon as the purge succeeds, whichever EmDash API deleted it.
- Every variant has one canonical URL, so one variant is one cache entry.
- Logged-out requests run no additional database queries. A cache hit runs none.

## Non-goals

- Caching audio, video and other non-image files. See [Errors and edge cases](#errors-and-edge-cases).
- Changing the browser `Cache-Control`, or making file URLs content-addressed (a new storage key or a version parameter on replace). That rewrites stored references in content and is a larger change.
- Media from external providers, or storage served from a public URL. Those responses don't pass through these routes.
- Limiting which widths, heights, formats or qualities `/_image` accepts, or snapping a width to the nearest preset. That changes which image URLs work and needs configuration, so it belongs in a separate plan together with issue #4214.
- A configuration option for the lifetime.

## Interfaces and compatibility

- No public API, configuration or stored data changes.
- Sites with a cache provider get a behavior change: image responses are cached for up to one year and carry the tag `emdash:media:<storageKey>`. The tag is namespaced, so tags that sites already purge are unaffected.
- On every site, a hand-written `/_image` URL for EmDash media with unknown, repeated or reordered parameters now answers with a `301` instead of the image. Browsers and crawlers follow it to the same image. URLs generated by Astro are unaffected.
- The route caching guide says that changes to the media library invalidate nothing. It will describe the media tag and which actions purge it. Cached pages are still not purged by media changes, because replace keeps the image URL. The pending plan for manual cache invalidation ([#4587](https://github.com/emdash-cms/emdash/pull/4587)) quotes that sentence about pages, so the two plans don't conflict.
- Ships as a minor release with a changeset for `emdash` and `@emdash-cms/cloudflare`.

## Errors and edge cases

- **Failed or rate-limited purge.** `invalidateRouteCache` logs and never throws, so a replace or delete still succeeds when the purge fails. Workers Cache rate-limits purge requests, and the editor doesn't see a rejected purge. The old or deleted image then stays cached until `maxAge` expires, up to a year. The way out is to purge again: the pending plan for manual cache invalidation ([#4587](https://github.com/emdash-cms/emdash/pull/4587)), or a purge in the Cloudflare dashboard.
- **Range requests.** `memoryCache()` keys entries by URL and ignores the `Range` header, so a cached file answers a ranged request with the whole file and status `200`. The prototype reproduced this on Node. Video and audio players depend on ranges, so only `image/*` responses are stored. Audio and video stay uncached until this is solved separately.
- **Many distinct variants.** `/_image` accepts any width and height from 1 to 4000, and every combination is already transformed on request today. Caching doesn't add transformations, and Cloudflare Images bills unique transformations whether or not they are cached. On Workers Cache, extra entries are evicted by the edge. With `memoryCache()` (an LRU with 1,000 entries by default), a flood of distinct variants can evict cached pages and make them render again. Sites that expect this can raise `max`.
- **Redirects are permanent.** Browsers keep a `301`. If a later EmDash version accepts a new parameter, a browser that cached the redirect for a URL containing it keeps dropping it until its cache clears. Only URLs that were not canonical when requested are affected.
- **`href` outside EmDash media.** Bundled assets, allowed remote images and `publicUrl` media are delegated to Astro's endpoint unchanged: no normalization, no caching.
- **Responses that are never stored:** `206`, `304`, `404`, `416` and error responses. Only whole `200` image responses and successful variants call `cache.set`.
- **Deletes outside EmDash.** Storage objects removed directly in the bucket are not purged and stay cached until `maxAge`. A plugin delete in a request-less context (a cron hook) purges through the runtime's bound cache invalidator, like plugin content actions; without one bound, it is not purged. New uploads get unique storage keys, so they never collide with a cached key.
- **Private keys.** The media file route refuses backup and transfer staging keys before it reads storage. Refused keys return `404` and are never cached.

## Verification

- Media file route: a whole image `200` sets the route cache with the tag and `maxAge`; a ranged request, a `304`, a `404` and a non-image file do not.
- Image endpoints on Node and Cloudflare: a successful canonical variant sets the same tag; a failed transform does not.
- Normalization: a URL from `getImage()` (with `fit` and `position`) is served without a redirect; unknown, repeated and reordered parameters return `301` to the canonical URL without transforming or caching; a repeated parameter redirects to its first value; `assetQueryParams` are kept.
- Replace: a successful replace invalidates the tag; a failed upload or metadata update does not. A rejected purge doesn't fail the replace.
- Delete through the media route, the MCP tool and `ctx.media.delete`: invalidates the tag when the stored file was removed, not when the media item doesn't exist.
- Without a cache provider, canonical requests return the same responses and headers as before.
- Logged-out query counts don't increase (`pnpm query-counts`).
- Manual check on Cloudflare with `cacheCloudflare()`: `BYPASS` before, `HIT` after; replace and delete take effect immediately for the file and a variant.

## Open questions

- Does Workers Cache key entries by the full query string? Normalization makes the answer irrelevant for correctness, but it decides whether the redirect is also needed to avoid duplicate entries on Cloudflare.
