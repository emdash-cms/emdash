---
title: Share cached pages across tracking query parameters on Cloudflare
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-11-21
---

# Share cached pages across tracking query parameters on Cloudflare

## Problem and user case

On Cloudflare, EmDash pages are cached by Workers Cache. Its cache key is the request path plus the full query string, and zone settings such as Cache Rules or "Ignore Query String" do not apply to it. Links from ads, newsletters and social posts carry parameters like `utm_source`, `fbclid` or `gclid`, and click IDs are unique per click. Each of those visits is a cache miss: the Worker renders the page and queries the database, although the page is the same as the cached one.

This is common on real sites. In a two-hour sample of a blog on EmDash, 11% of page renders had a query string; on a small campaign site it was 67%. Sites that run ads or newsletters pay for it in render time, database load and visitor latency exactly when traffic peaks.

Pages can't fix this themselves. Only an outer entrypoint that calls the cached entrypoint through `ctx.exports` with a rewritten URL or `cf.cacheKey` changes the key. Cloudflare documents that pattern, but each site has to build it, and it has a non-obvious purge trap (see [Errors and edge cases](#errors-and-edge-cases)).

## Proposed behavior

`@emdash-cms/cloudflare/worker` gains an opt-in gateway. A site enables it in its Worker entry and Wrangler configuration:

```ts
// src/worker.ts
import {
	createScheduledHandler,
	createTrackingGateway,
	EmDashSite,
} from "@emdash-cms/cloudflare/worker";

export { EmDashSite };

export default {
	fetch: createTrackingGateway(),
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
```

```jsonc
// wrangler.jsonc
"exports": {
	"default": { "type": "worker", "cache": { "enabled": false } },
	"EmDashSite": { "type": "worker", "cache": { "enabled": true } },
},
```

- The default entrypoint runs on every request. For `GET` and `HEAD` it removes known tracking parameters from the URL and forwards the request to `EmDashSite` through `ctx.exports`. `EmDashSite` runs the existing EmDash fetch handler and is the only cached entrypoint.
- The removed set is fixed: `utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`, `dclid`, `msclkid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`, `igshid`, `ttclid`, `twclid`, `li_fat_id` and `yclid`, matched case-insensitively by name. Other parameters keep their order and values, so `?cursor=` still gets its own entry.
- Page code sees the stripped URL, so `Astro.url` never contains tracking parameters and cached HTML can't contain a visitor's click ID. The browser keeps the full URL, so client-side analytics still read the parameters.
- Purges and invalidations reach `EmDashSite`'s cache. Request handlers already run inside it. The `scheduled()` sweep runs in the default entrypoint, so with the gateway enabled `createScheduledHandler()` calls an `EmDashSite` RPC method that runs the whole sweep there, including plugin cron and its purges.
- Without the gateway nothing changes: the default export stays the cached entrypoint.

A prototype ran on a lab Worker with the same build and the same D1 database as a stock comparison Worker; only the gateway differed. After warming the clean URLs, 6 regions each sent 60 requests per variant, in two runs:

| Measurement                                           | Stock                                 | With gateway             |
| ----------------------------------------------------- | ------------------------------------- | ------------------------ |
| Tracked URLs served from cache (of 360)               | 0 and 90 (only repeated utm sets hit) | 360 and 360              |
| Tracked URLs, TTFB p50 / p90                          | 926 / 2089 ms and 455 / 1215 ms       | 8 / 250 ms and 8 / 23 ms |
| Page renders for 360 tracked requests                 | 360 and 270, about 6.4 queries each   | 0                        |
| Clean cached URLs, TTFB p50 / p99 (2 x 1200 requests) | 5 / 31 to 43 ms                       | 7 to 8 / 203 to 274 ms   |
| Billed Worker requests per page view                  | 1                                     | 2                        |

Publishing a post through the content API on the gateway Worker refreshed the cached detail, list and home pages, and a tracked URL of the detail page then served the new content from cache.

Scheduled publishing was checked on the same Worker with a one-minute Cron Trigger. A post was published with one title, then a new title was scheduled about 45 seconds ahead while the detail, list and tracked detail URLs were cached:

- With the stock `createScheduledHandler()` in the default entrypoint, the sweep published the new title, but all cached pages stayed `HIT` with the old title.
- With the default entrypoint calling an RPC method on the cached entrypoint that runs the same sweep, the detail and list pages were `MISS` with the new title right after the sweep, and the tracked detail URL was then a `HIT` with the new title.

## Goals

- Requests that differ from a cached URL only by known tracking parameters are served from the same cache entry.
- No visitor's tracking parameters appear in server-rendered output.
- Every purge and invalidation EmDash issues today, including scheduled publishing, still reaches the cached pages.
- Sites that don't opt in see no change in behavior, cost or latency.

## Non-goals

- Enabling the gateway by default. It doubles billed requests for every page view and raises tail latency for all visitors, which only pays off on sites with a large share of tracked traffic.
- A configurable parameter list. The fixed list covers the common ad and email platforms; a site that needs more can write its own gateway with the same pattern.
- Normalizing parameter order or other query parameters, or changing caching on Node.
- Server-side attribution. Sites that read tracking parameters in server code should not enable the gateway.

## Interfaces and compatibility

- New exports from `@emdash-cms/cloudflare/worker`: `createTrackingGateway()` and the `EmDashSite` entrypoint class. The existing default handler, `createScheduledHandler()` and the room classes behave as today when the gateway isn't used.
- Enabling the gateway is a manual change to the site's Worker entry and Wrangler `exports`. The `ctx.exports` loopback needs a compatibility date of 2025-11-17 or later, or the `enable_ctx_exports` flag.
- No stored data or EmDash configuration changes. The route-caching guide documents the option, its billing effect and when it pays off.

## Errors and edge cases

- Workers Cache purges only reach the entrypoint that issues them. A purge from the default entrypoint leaves stale pages in `EmDashSite`'s cache (seen in the prototype for scheduled publishing), so every purge path must run inside `EmDashSite`. A site that enables the gateway but keeps a hand-written `scheduled()` that purges in the default entrypoint gets this failure silently; the docs call it out.
- Every request, including cache hits, is billed twice (gateway and loopback). The gateway adds about 2 to 3 ms at p50; in the prototype about 2% of hits took more than 100 ms because the uncached gateway runs on every request.
- Other methods such as `POST` pass through with their query intact. Authenticated and preview requests keep bypassing the cache; the gateway forwards headers and cookies unchanged.
- Server code that reads tracking parameters, such as a plugin that stores `utm_source` with a form submission made by `GET`, no longer sees them. This is one reason the option is off by default.
- Canonical and redirect URLs built from `Astro.url` lose tracking parameters. The docs mention this.

## Verification

- Workerd tests for the gateway: tracking parameters are removed, other parameters and their order are kept, matching is case-insensitive, other methods are unchanged, and the forwarded request keeps method, headers and body.
- A test that the page sees the stripped URL, so a click ID can't reach rendered HTML.
- A test that, with the gateway enabled, the scheduled-publishing purge runs in `EmDashSite` and invalidates its entries, and that it behaves as today without the gateway.
- Manual check on a deployed Worker: a tracked URL is a `HIT` after the clean URL was cached, and after both an admin publish and a scheduled publish the clean and tracked URLs show the new content.

## Open questions

- Should the gateway live in `@astrojs/cloudflare` instead, since the adapter owns the Worker entry and the same problem affects every Astro site on Workers Cache? EmDash would then only document it and route its scheduled purges.
- Running the whole sweep in `EmDashSite` covers scheduled publishing and plugin cron. Which other paths purge outside a request, such as queue consumers that use `withEmDashRuntime()`? Each needs the same RPC route, or the docs must say that such purges don't reach the cache.
