---
title: Cache media files in the route cache
type: feature-plan
status: implemented
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

When the site configures a compatible Astro cache provider, such as `cacheCloudflare()`, EmDash stores image responses in the route cache and purges them when the image changes. A custom provider must preserve distinct source `href` values and transform options in its cache keys and support conditional request semantics; this plan does not guarantee compatibility with every provider.

The implementation narrows the accepted plan's scope: automatic media caching is disabled for Astro's `memoryCache()` at every response size, replacing the proposed size limit. Variant normalization and caching apply only to Astro's stock sharp service (`astro/assets/services/sharp`) on Node and `@astrojs/cloudflare/image-service-workerd` on Cloudflare. Custom local image services retain their existing transform path without new redirects or cache intent.

- A whole `200` image response from the media file route, and a successful eligible variant from a stock image service, calls `context.cache.set({ maxAge: 31536000, tags: ["emdash:media:<storageKey>"] })`. The lifetime is one year; successful purges remove entries sooner. The media file route caches only requests without a query string, so query strings, including the admin's `_emdash_media` preview parameter, can't add entries for the same file.
- Storage keys with characters other than ASCII letters, digits, `.`, `_` and `-`, or longer than 1,011 characters, are not cached. The full `emdash:media:<storageKey>` tag must fit Cloudflare's 1,024-character purge limit. These restrictions apply to cache eligibility, not existing media URLs or storage access.
- A variant's `href` is cacheable only when it is exactly `/_emdash/api/media/file/<safeKey>` or `requestUrl.origin` followed by that path. Nested queries (including `_emdash_media`), fragments, foreign origins and alternate path spellings are passed unchanged to the existing image handling but are not stored. Relative and plain same-origin absolute forms are both accepted and can produce separate cache entries.
- With the stock services, variant URLs for EmDash media are normalized before anything is transformed. The canonical outer query holds the parameters Astro's `getURL` writes, in its order (`href`, `w`, `h`, `q`, `f`, `fit`, `position`, `background`), each at most once, followed by the adapter's `assetQueryParams`. A request whose query differs from its canonical form (unknown parameters, a repeated parameter, another order or encoding) gets a `301` to the canonical URL. A repeated parameter keeps the first value, which the endpoint uses. Normalization preserves the `href` value, including any nested query. URLs built by `<Image>` and `getImage()` with the stock services are already canonical and never redirect. This prevents extra entries from unknown or reordered outer parameters without merging the two accepted source forms.
- A replace invalidates `emdash:media:<storageKey>` as soon as the new file is stored, even if the metadata update after it fails, because the bytes under the key have already changed. One purge removes the original file and every cached variant of it.
- A successful delete that removed the stored file of a cacheable image (an `image/*` type or an image file extension, with a cacheable key) invalidates the same tag, so a deleted image stops being served from the cache. Deleting other media costs no purge. This covers the media routes, the MCP `media_delete` tool and `ctx.media.delete` in plugins. On Cloudflare, stored files that scheduled cleanup removes later, after a delete could not remove them, are purged then.
- A sandboxed plugin's `ctx.media.delete` uses an invocation-scoped `PluginRuntimeBridge`, so deletion and its callback stay in the originating host isolate. The callback queues the purge for flushing on the host invocation, where the cached media responses belong. This does not guarantee a purge after a wall-time timeout; see the timeout limitation below.
- The `Cache-Control` header that browsers see stays `public, max-age=0, must-revalidate` with the existing `ETag` and `Last-Modified` validators. Browser caches can't be purged, so a replaced image must still revalidate there. Compatible providers must preserve the endpoint's conditional `304` behavior for unchanged images.
- Without a cache provider, nothing is cached. Non-canonical variant URLs still redirect with the stock services. Custom-service parameters are preserved without normalization, regardless of the provider.

A prototype ran on a throwaway Cloudflare Worker with its own D1 database and R2 bucket, using a 1.4 MB PNG and `cacheCloudflare()`. The requests came from one client and were few, so the numbers are indicative:

| Request                            | EmDash 1.4.0                       | Prototype                                                                              |
| ---------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| Original file, repeated            | `BYPASS` every time, 150 to 230 ms | `HIT`, 45 to 130 ms                                                                    |
| `/_image` variant, `w=400`, WebP   | not measured                       | first `MISS` 350 ms, then `HIT` 45 to 55 ms; `If-None-Match` returns `304`             |
| After replace                      |                                    | immediate `MISS` with the new bytes (checked by MD5), then `HIT`; same for the variant |
| After delete                       |                                    | `404` for the file and the variant                                                     |
| `Range` request for a cached image |                                    | `206` with the requested bytes                                                         |

The baseline numbers come from a different image on a different Worker (the stock demo site). On Node with `memoryCache()`, the prototype showed the same hit, replace and delete behavior for original files. These are historical prototype measurements: `memoryCache()` support is excluded from the shipped behavior, and the measurements do not verify the implementation's sandbox timeout handling. The prototype is commit [`aa90da5`](https://github.com/swissky/emdash/commit/aa90da512) on the fork branch [`proto/4498-media-edge-cache`](https://github.com/swissky/emdash/tree/proto/4498-media-edge-cache).

## Goals

- Repeated views of eligible images and stock-service variants are served from a compatible route cache.
- New visitors see a replaced image once the purge succeeds, subject to concurrent cache fills.
- A deleted image stops being served once its purge succeeds, with the invocation and cleanup limitations below.
- Unknown, repeated or reordered outer query parameters do not create additional cached stock-service variants.
- Logged-out requests run no additional database queries. A cache hit runs none.

## Non-goals

- Caching audio, video and other non-image files. See [Errors and edge cases](#errors-and-edge-cases).
- Changing the browser `Cache-Control`, or making file URLs content-addressed (a new storage key or a version parameter on replace). That rewrites stored references in content and is a larger change.
- Media from external providers, or storage served from a public URL. Those responses don't pass through these routes.
- Limiting which widths, heights, formats or qualities `/_image` accepts, or snapping a width to the nearest preset. That changes which image URLs work and needs configuration, so it belongs in a separate plan together with issue #4214.
- A configuration option for the lifetime.
- Storing transformed variants in the media storage, so an evicted variant isn't transformed again. Stored variants don't expire like cache entries, need cleanup on replace and delete, and need limits on which variants exist, so this belongs in the separate plan with issue #4214.

## Interfaces and compatibility

- No public API, configuration or stored data changes.
- Sites with a compatible cache provider get a behavior change: eligible image responses are cached for up to one year and carry the tag `emdash:media:<storageKey>`. The tag is namespaced, so tags that sites already purge are unaffected. `memoryCache()` continues to support page caching but receives no automatic media cache entries.
- With a stock image service, a hand-written `/_image` URL for EmDash media with unknown, repeated, reordered or differently encoded outer parameters answers with a `301` instead of the image, even without a cache provider. Browsers and crawlers follow it to the same image. Stock-service URLs generated by Astro are unaffected; custom services retain their parameters and existing handling.
- The route caching guide says that changes to the media library invalidate nothing. It will describe the media tag and which actions purge it. Cached pages are still not purged by media changes, because replace keeps the image URL. The pending plan for manual cache invalidation ([#4587](https://github.com/emdash-cms/emdash/pull/4587)) quotes that sentence about pages, so the two plans don't conflict.
- Ships with minor changesets for `emdash` and `@emdash-cms/cloudflare`, and a patch for `@emdash-cms/sandbox-workerd`.

## Errors and edge cases

- **Failed or rate-limited purge.** `invalidateRouteCache` logs and never throws, so a replace or delete still succeeds when the purge fails. Workers Cache rate-limits purge requests, and the editor doesn't see a rejected purge. The old or deleted image then stays cached until `maxAge` expires, up to a year. The way out is to purge again: the pending plan for manual cache invalidation ([#4587](https://github.com/emdash-cms/emdash/pull/4587)), or a purge in the Cloudflare dashboard.
- **Provider compatibility.** Astro's `memoryCache()` normalizes cache keys and does not preserve conditional request semantics for media. It is excluded entirely, rather than limited by response size. Other providers must distinguish source `href` values and transform options and handle conditional requests correctly; provider compatibility needs verification in the deployed environment.
- **Range requests.** The prototype reproduced `memoryCache()` answering a ranged request with the whole cached file and status `200`. Automatic media caching excludes this provider and remains limited to images. Audio, video and partial responses are not stored.
- **Many distinct variants.** The Cloudflare endpoint accepts widths and heights from 1 to 4000, and distinct combinations still require transforms on cache misses. Normalization does not bound the number of valid variants. Cache capacity and eviction depend on the provider.
- **Redirects are permanent.** Browsers keep a `301`. If a later EmDash version accepts a new parameter, a browser that cached the redirect for a URL containing it keeps dropping it until its cache clears. Only URLs that were not canonical when requested are affected.
- **`href` outside EmDash media.** Bundled assets, allowed remote images and `publicUrl` media are delegated to Astro's endpoint unchanged: no normalization, no caching.
- **Responses that are never stored:** `206`, `304`, `404`, `416` and error responses. Only whole `200` image responses and successful variants call `cache.set`.
- **Deletes outside a purge-capable invocation.** Storage objects removed directly in the bucket are not purged and stay cached until `maxAge`. Plugin hooks and cron jobs need a bound runtime cache invalidator; on Cloudflare a Cron Trigger binds one in its Worker isolate. Node's scheduled cleanup does not purge removed files. New uploads get unique storage keys, so they never collide with a cached key.
- **Sandbox timeouts.** Invocation-scoped bridges keep deletion and its callback in the originating host isolate, but a sandboxed delete that finishes after the plugin route's wall-time limit can still miss its purge if that route never completes. The host flush and any late-completion cleanup depend on the invocation lifetime; a grace timer is not a verified purge guarantee on deployed Cloudflare Workers.
- **Concurrent cache fills.** A response generated during a successful purge can be stored afterwards with the old bytes and remain until expiry or another purge.
- **Private keys.** The media file route refuses backup and transfer staging keys before it reads storage. Refused keys return `404` and are never cached.

## Verification

- Media file route with a compatible provider: a whole image `200` sets the route cache with the tag and `maxAge`; a ranged response, a `304`, a `404`, a non-image file, any query string (including `_emdash_media`) and an uncacheable key do not.
- Astro's real `memoryCache()`: originals and variants do not populate the cache at any size. Requests with different sources and transform options remain distinct, and conditional requests retain their endpoint behavior.
- Image endpoints on Node and Cloudflare: a successful canonical stock-service variant with a plain relative or same-origin absolute `href` sets the same tag; a failed transform does not. Nested queries, fragments, foreign origins and alternate source spellings are not cached and retain their existing handling.
- Normalization with the stock services: a URL from `getImage()` (with `fit` and `position`) is served without a redirect; unknown, repeated, reordered and differently encoded outer parameters return `301` to the canonical URL without transforming or caching; a repeated parameter redirects to its first value; `assetQueryParams` and nested `href` values are kept. The same normalization applies without a provider.
- Custom image services: service-specific parameters reach the existing transform path unchanged, without normalization redirects or new variant cache intent.
- Replace: a stored replacement invalidates the tag, also when the metadata update fails afterwards; a failed upload does not. A rejected purge doesn't fail the replace.
- Delete through the media route, the MCP tool and `ctx.media.delete`: invalidates the tag when the stored file of a cacheable image was removed, not when the media item doesn't exist, the file wasn't removed, or the media is not a cacheable image.
- Sandbox deletion: real workerd RPC uses the invocation-scoped bridge and flushes queued media invalidations on the originating host invocation. Verify timeout and late-completion paths separately; unit timers do not establish deployed Workers lifetime guarantees.
- Without a cache provider, canonical requests return the same responses and headers as before.
- Logged-out query counts don't increase (`pnpm query-counts`).
- Manual check on Cloudflare with `cacheCloudflare()`: `BYPASS` before, `HIT` after; replace and delete take effect immediately for the file and a variant.

## Open questions

- Answered: Workers Cache keys entries by the full URL, including the query string, so the redirect also avoids duplicate entries on Cloudflare.
