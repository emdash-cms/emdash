---
title: Invalidate cached pages from the admin, the CLI and the REST API
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: https://github.com/emdash-cms/emdash/discussions/2021
created: 2026-11-02
---

# Invalidate cached pages from the admin, the CLI and the REST API

## Problem and user case

EmDash invalidates the route cache and the object cache when content is written through the admin, the REST API or MCP. Other changes never trigger an invalidation:

- a script that updates D1 with `wrangler d1 execute --remote`, as in issue #2435;
- a migration, bulk import or external sync job that writes the database directly;
- byline and media library changes, which the route caching guide says invalidate nothing;
- a purge that failed or was rate-limited, which also fails without an error in the admin.

Visitors then see the old page until `maxAge` expires, and EmDash offers no way to refresh it. On Cloudflare, a zone purge from the dashboard or the Cloudflare API doesn't help: only the Worker that owns its [Workers Cache](https://developers.cloudflare.com/workers/cache/purge/) can purge it. What remains is a redeploy, which only empties the cache while `cross_version_cache` is off, or a purge endpoint the site owner writes and protects themselves.

Issue #2208 and Ideas Discussion #2021 ask for the same recovery from the admin, because the people who publish content are usually not the people who control the CDN.

## Proposed behavior

An administrator, or a script holding an API token, asks EmDash to refresh cached pages. A request names one or more targets:

- **Entries**, by collection and ID or slug, with an optional locale. EmDash invalidates the tags it invalidates when that entry is published: the collection name and the entry ID.
- **Paths**, as exact request paths such as `/blog`. Each path is invalidated with and without a trailing slash, as redirect writes already do.
- **Tags**, passed through unchanged. This reaches custom tags, including the broad `all` tag the route caching guide recommends adding to every route rule.
- **All EmDash content**: every collection tag and every settings, menu, taxonomy and widget area tag of the site.

Entry targets also clear the object cache for the entry's collection, bylines and taxonomies, because cached entry reads include byline and term data. "All EmDash content" clears every object-cache namespace and isolate cache that a site import clears, by reusing that routine. Path and tag targets leave the object cache alone, because they don't map to a namespace.

Every successful request writes an audit log entry with the actor and the number of targets of each kind.

### CLI

The CLI covers the scripted case from issue #2435:

```sh
wrangler d1 execute my-site --remote --file ./article.sql
npx emdash cache invalidate --entry posts/hello-world
```

Other forms:

```sh
npx emdash cache invalidate --entry posts/hallo-welt --locale de
npx emdash cache invalidate --path / --path /blog
npx emdash cache invalidate --tag all
npx emdash cache invalidate --all
```

`--entry` takes `collection/id-or-slug`. `--entry`, `--path` and `--tag` can repeat. The command authenticates like the other remote commands, through `emdash login` or `EMDASH_TOKEN`. It prints what it invalidated, supports `--json`, and exits with a non-zero status when the request fails. The command help recommends `--entry` for scripts, because `--all` costs several purge requests.

### REST API

`POST /_emdash/api/settings/cache/invalidate` takes either targets:

```json
{
	"entries": [{ "collection": "posts", "id": "hello-world", "locale": "en" }],
	"paths": ["/blog"],
	"tags": ["all"]
}
```

or `{ "all": true }` on its own. A successful response lists what was invalidated:

```json
{
	"data": {
		"routeCache": "invalidated",
		"objectCache": "invalidated",
		"tags": ["posts", "01JD6Z8Y7Q0RJ4W1X2K3M5N6P7"],
		"paths": ["/blog", "/blog/"]
	}
}
```

`routeCache` and `objectCache` are each `invalidated` or `not_configured`.

### Admin

A **Cache** page under Settings offers two actions, as discussed in #2021:

- **Refresh all pages**, behind a confirmation dialog, which sends the "all EmDash content" request. A checkbox in the dialog, "Also refresh pages tagged `all`", adds that tag for sites whose route rules use it.
- **Refresh a path**, with an input for one path.

The page offers no per-entry action. Saving an entry already refreshes it, and a button next to every entry would suggest that editors have to purge by hand. Results and errors appear as toasts. When the response reports `not_configured` for both caches, the toast says that caching isn't set up on this site.

## Goals

- Let a script or CI job refresh the pages a write outside EmDash affected, using an EmDash API token and no platform credentials.
- Give administrators a recovery action for the whole site and for a single path.
- Reach the same pages for an entry that EmDash's automatic invalidation reaches when that entry is published.
- Call only Astro's `cache.invalidate()` for the route cache, so the feature works with every Astro cache provider and core gains no platform-specific code.

## Non-goals

- Purging every cached response. Astro's invalidation API has no "purge everything", and adding one belongs in Astro. "All EmDash content" doesn't reach pages tagged only by entry ID or by custom route-rule tags. Sites that need a full purge tag their routes with `all` and invalidate that tag.
- A site-wide tag added to every cache hint, such as `emdash:all`. It would change the tags of every response and needs its own proposal.
- A plugin API (`ctx.cache`). It can follow in its own design once this HTTP surface exists.
- Detecting writes made outside EmDash, or invalidating automatically after them.
- Per-entry purge buttons, a tag input in the admin, cache statistics, or a separate status endpoint.

## Interfaces and compatibility

All changes are additive.

- **Route:** `POST /_emdash/api/settings/cache/invalidate` in core. It requires the existing `settings:manage` permission, which only Admins hold. Token requests need the `settings:manage` scope, which the existing write rule for `/_emdash/api/settings` already enforces, so the auth package doesn't change. Anyone who can change site settings already triggers a site-wide purge of the settings tag. Session requests need the `X-EmDash-Request` header like every other write. No logged-out route changes.
- **Audit log:** a new `cache_invalidate` audit action.
- **Client and CLI:** `EmDashClient.invalidateCache()` and the `emdash cache invalidate` command.
- **Admin:** a Cache settings page. All strings go through Lingui, and the layout uses logical Tailwind classes.
- **Reuse:** tags go through the existing `invalidateRouteCache` batching in chunks of 100, paths through the existing redirect helper that adds the trailing-slash variant, and "all" object-cache invalidation through the site import's cache routine.
- **Platform code:** none. `@emdash-cms/cloudflare` doesn't change, and the route works with `memoryCache()` on Node.
- **Database:** no new tables or migrations. "All EmDash content" reads collection, menu, taxonomy and widget area names with existing queries.
- **Docs:** the route caching and object cache pages describe the command and route for changes made outside EmDash. The Cloudflare page points to them instead of a hand-written purge endpoint.

## Errors and edge cases

- **No cache configured:** Astro's `cache.invalidate()` throws when no provider is configured, so the route checks `cache?.enabled` first. It then reports `not_configured` for that cache and succeeds. `astro dev` never caches, so local runs report `not_configured` for the route cache.
- **Validation:** an empty body, `all` combined with other targets, or more than 100 targets fails with `400 VALIDATION_ERROR`. Paths must start with `/`, must not start with `//`, and must not contain a query string or fragment. Tags must be non-empty, contain no commas, and be at most 1,024 characters long.
- **Unknown collection:** `400 VALIDATION_ERROR` naming the collection.
- **Unknown entry:** `404 NOT_FOUND` when no row in that collection and locale has the given ID or slug. An entry already removed from the database can still be refreshed with `--tag <id>` or `--tag <collection>`.
- **Translations:** an entry target refreshes one locale row, as publishing does. Without `locale`, a slug resolves in the default locale. Other translations need their own targets.
- **Provider failure:** when `cache.invalidate()` throws, the route returns `500 CACHE_INVALIDATE_FAILED` without the provider's message. Unlike automatic invalidation, a failed purge fails the request. Batches sent before the failure stay invalidated, and the error says so.
- **Rate limits:** on Cloudflare, each batch of tags and each path costs one Workers Cache purge request, from the same per-account allowance as every editor's saves. `cacheCloudflare()` doesn't report a rejected purge to Astro, so EmDash reports a rate-limited request as invalidated. A request that would need more than 10 purge requests fails with `400 VALIDATION_ERROR`. The docs list the cost of each target next to the existing rate-limit section.
- **Concurrency:** requests aren't deduplicated. Two administrators refreshing everything at once each pay the full cost.
- **Object cache timing:** epoch writes reach the backend after the response, as they do for every write today. Other isolates pick up the new epochs within their `revalidate` window. Anonymous renders on a route-cached site skip the object cache, so refilled pages read from the database.
- **Node with several processes:** `memoryCache()` only clears the process that handled the request, the same limit automatic invalidation has today.

## Verification

- Handler tests on SQLite and PostgreSQL with a recording cache stub:
  - entry targets by ID, by slug, and by slug with a locale resolve to `[collection, id]`;
  - paths expand to both slash forms, and `/` stays one path;
  - "all EmDash content" sends every collection and chrome tag in batches of at most 100;
  - unknown collections and entries are rejected, and the purge-request limit is enforced;
  - entry and "all" targets bump the expected object-cache namespaces.
- Route tests:
  - Admin sessions and tokens with `settings:manage` succeed;
  - Editors, tokens with only `settings:read` or `content:write`, and session writes without `X-EmDash-Request` get `403`;
  - a throwing provider returns `500 CACHE_INVALIDATE_FAILED`, and a disabled cache returns `not_configured`;
  - a successful request writes one `cache_invalidate` audit entry.
- CLI tests: argument parsing for `--entry`, `--locale`, `--path`, `--tag` and `--all`, the exit status on failure, and `--json` output.
- The query-count snapshot shows no change for logged-out routes.
- A manual pass on a deployed Cloudflare site, repeating issue #2435: write an entry with `wrangler d1 execute --remote`, confirm the cached page is stale, run `emdash cache invalidate --entry`, and confirm the next request shows the new content. A second pass checks the admin page in light and dark mode, in Arabic, and with a keyboard.

## Open questions

- Is 10 purge requests per call the right ceiling, or should the limit follow the provider?
- Should Editors be able to refresh a single path? This plan limits every action to Admins, as #2021 asks.
