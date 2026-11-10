---
title: Render Cloudflare sites inside a Durable Object
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: Kevin Kyburz (@swissky)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4789
created: 2026-11-09
---

# Render Cloudflare sites inside a Durable Object

> Numbers come from a prototype on three live sites and an isolated benchmark (November 7 to 10, 2026): curl and browser `fetch` samples from Zurich, Cloudflare zone analytics, CoreDash RUM and load tests. Each number names its date and setup. The full measurement write-up is in [Up to ten times faster without a cache: EmDash in a Durable Object](https://kevinkyburz.ch/blog/emdash-durable-object/).

## Summary

Add an opt-in Cloudflare deployment mode to `@emdash-cms/cloudflare` in which the Astro SSR app and the site's SQLite database run in the same Durable Object. A small front Worker serves the Workers Cache and forwards cache misses to that object over RPC. Database queries become in-process calls on `ctx.storage.sql` instead of network round trips, and one warm instance serves every cache miss instead of a cold isolate per location.

D1 stays the default. The existing `durableObjects()` adapter is unchanged. Sites that don't opt in see no change.

## Problem and user case

Sites on Workers + D1 + R2 with route caching are fast on a cache hit (about 16 to 40 ms) and slow on a miss. Visitors rarely miss (under 2% on our sites), but crawlers, new regions, editors in the admin, and every page after a purge or deploy do.

Two causes, measured on stock EmDash 1.4.0 (emdash-demo, D1, `session: "auto"`, no placement):

1. **Serial D1 round trips.** One D1 query costs about 17 ms. An uncached page runs 14 to 25 queries in sequence (emdash-demo 14, linguadash.dev 23, scllauerz.ch 25), so about 250 ms goes to waiting on the database. A warm page takes 0.29 to 0.39 s.
2. **Cold isolates on low-traffic sites.** Workers run in hundreds of locations. With little traffic, most misses land on a new isolate: 1.1 to 2.4 s, including about 250 ms to evaluate a 19 MB bundle and 170 to 330 ms for the first D1 access. After 30 s without visitors the next request was cold again.

Mitigations available today don't close the gap:

| Mitigation                          | Measured effect                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `migrations: { runtime: "manual" }` | about 85 ms saved on a cold start; the first D1 access moves to `_plugin_state`                                      |
| Smart Placement + KV object cache   | warm 0.17 to 0.39 s, but 11 of 21 samples cold at 0.86 to 1.72 s                                                     |
| `durableObjects()` adapter          | replaces D1 with DO SQLite, but rendering stays in the Worker and every query is an RPC; cold isolates are unchanged |

This affects small and medium sites on Cloudflare (blogs, club sites, marketing sites), the main audience of the Cloudflare templates. Search crawlers see the slow path most often, which affects indexing and field data.

## Evidence

Same seed data, D1 Worker against front Worker + Durable Object:

| Case                                  | D1             | Front + DO                                     |
| ------------------------------------- | -------------- | ---------------------------------------------- |
| Warm                                  | 0.29 to 0.39 s | 0.08 to 0.23 s                                 |
| New location or isolate, object warm  | 1.05 to 2.44 s | 0.10 to 0.28 s                                 |
| After 30 / 90 / 180 s idle            | 1.12 to 2.41 s | 0.12 to 0.16 s                                 |
| After 5 / 10 min idle, no keep-alive  | 1.19 / 1.28 s  | 0.21 / 0.13 s (earlier samples: 0.70 / 0.74 s) |
| Right after a deploy, everything cold | 1.06 to 1.65 s | 0.76 to 0.95 s                                 |

Live sites after the switch (zone analytics, HTML 200, cache miss, median; before = 7 days on D1):

| Site                                    | Before   | After  |
| --------------------------------------- | -------- | ------ |
| scllauerz.ch, worldwide                 | 2,837 ms | 291 ms |
| scllauerz.ch, from Singapore            | 3,264 ms | 256 ms |
| kevinkyburz.ch (before: Placement + KV) | 726 ms   | 204 ms |
| linguadash.dev (low traffic)            | 1,184 ms | 450 ms |

CoreDash p75 TTFB on scllauerz.ch: 1,025 ms over the 31 days before, 196 ms in the first 24 hours after the switch and 296 ms in the 24 hours to November 10 (no TTFB sample rated poor). Three sites, mostly European visitors, early data.

Misses are more common for real visitors than the zone cache ratio suggests. Zone analytics counted 0.8% of HTML page views on scllauerz.ch as misses, but those counts include crawlers and a cache warmer (warmup.rocks) that keeps the main pages hot. CoreDash only counts real browsers. Over the 31 days to November 9 (979 page loads, almost all on D1):

| TTFB                           | Share of page loads |
| ------------------------------ | ------------------- |
| under 250 ms (cache hit range) | 62%                 |
| 875 ms or more                 | 26%                 |
| 1,875 ms or more               | 14%                 |

The slow loads cluster between 1.0 and 2.5 s, the range we measured for a D1 cache miss on a cold isolate, and visitors close to the site are affected as much as distant ones. RUM TTFB also includes DNS and connection setup, so not every slow load is a miss, but a hit on the same network measures 16 to 40 ms. Crawlers come on top and request long-tail pages that are rarely cached: Search Console crawl stats for kevinkyburz.ch show Googlebot's average response time rising from 212 ms (August 11 to September 30, WordPress) to 532 ms (October 1 to November 7, EmDash on D1 with Smart Placement and KV) at the same download size of about 10 KB per request. On November 8, the day of the move, it was 69 ms (one day of data; Search Console does not split response time by file type).

The prototype needed no change to `emdash` or `@emdash-cms/cloudflare` 1.4.0. It uses `database: { entrypoint, type: "sqlite" }` with an in-process dialect and a custom `cache.provider`. Core support is about making this safe, supported and upgradeable, not about making it possible.

## Example

```js
// astro.config.mjs (names are placeholders, see open questions)
import { cloudflareSite } from "@emdash-cms/cloudflare";

export default defineConfig({
	adapter: cloudflare(),
	integrations: [
		emdash({
			database: cloudflareSite({ binding: "EMDASH_SITE" }),
			storage: r2({ binding: "MEDIA" }),
		}),
	],
});
```

```jsonc
// wrangler.jsonc (shape only)
{
	"durable_objects": {
		"bindings": [{ "name": "EMDASH_SITE", "class_name": "EmDashSite" }],
		"code_update_strategy": { "mode": "immediate" },
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["EmDashSite"] }],
}
```

On a cache miss: front Worker -> `env.EMDASH_SITE.getByName("site").fetch(request)` -> `EmDashSite` runs the Astro app with an in-process Kysely dialect -> the response passes back through the front Worker into the Workers Cache. A publish purges tags through the front Worker.

## Goals

- Cut uncached TTFB for low-traffic Cloudflare sites from 1 to 3 s to well under 0.5 s near the object's region, without a cache warmer.
- Make the database round trip cost on page renders close to zero.
- Keep EmDash core behavior identical: same migrations, same schema, same admin, same plugins, same caching and invalidation semantics.
- Opt-in, additive, reversible: a site can move from D1 to the new mode and back with an export and import.
- Ship it as a documented, tested mode instead of a fork of `worker.ts` that each site maintains.

## Non-goals

- Changing the default for new sites or templates. That is a later decision based on data from this mode.
- Multi-region writes, or read replicas that also render. The first version has one object per site (see open questions).
- Multi-tenant hosting (many sites in one Worker). Possible later with one object per site name.
- Replacing the existing `durableObjects()` database adapter.
- Node.js. Node already renders and queries in one process.

## Detailed design

### Components

1. **Front Worker.** Owns the Workers Cache. On a miss it calls the site object over RPC, passes the response back, and exposes `purge(tags)` for the object. Must stay tiny: the first prototype put the 19 MB bundle in front and was as slow cold as D1 (1.3 to 2.0 s). It has no EmDash code on its import path.
2. **`EmDashSite` Durable Object** (SQLite-backed). Imports the normal Astro SSR entry and calls its `fetch`. The dialect needs the object's storage, but Vite duplicates modules across SSR chunks, so it can't be passed through module scope. The live-site prototypes (kevinkyburz.ch, scllauerz.ch, linguadash.dev) register `ctx.storage.sql` on `globalThis` under a `Symbol.for` key in the constructor. Cloudflare documents that objects defined in the same Worker code may share global memory, so core should instead scope storage per request: the isolated benchmark keeps one `AsyncLocalStorage<DurableObjectStorage>` on `globalThis` and runs each request, including consumption of the response body, inside `scope.run(ctx.storage, ...)`.
3. **In-process dialect.** Kysely dialect over `ctx.storage.sql`, sharing execution code with `EmDashDB` (see Core integration surface). Requirements learned from the prototype and upstream:
   - An introspector that skips `_cf_%` tables. Kysely's `SqliteIntrospector` reads `pragma_table_info` for every table and fails with `SQLITE_AUTH` on Cloudflare's internal tables. This stays hidden until the first EmDash update with a pending migration, then the site renders without CMS data. The upstream `D1Introspector`, which the existing DO dialect already uses, skips them with `not like '_cf_%'` and should be reused. `_` is a `LIKE` wildcard, so that pattern also skips names like `xcfy...`; harmless for EmDash tables.
   - `numAffectedRows` from `SELECT changes()`, not `cursor.rowsWritten` (see #3633). `rowsWritten` also counts index and trigger writes: updating one indexed row reports 2. EmDash checks `numUpdatedRows === 1` in several places, so with `rowsWritten` adding a field failed with `SCHEMA_FIELD_CREATE_ERROR` (`invalidateIndexStatusForSchemaChange`). Fixed in the prototype on November 9.
   - `beginTransaction` throws the message `withTransaction` probes for, matching D1 and the existing DO dialect. Open question: in-process, `ctx.storage.transactionSync()` could give real atomicity for synchronous callbacks, but EmDash's transaction callbacks are async.
   - `executeCollectionDeletionGuard` plus `supportsCollectionDeletionGuard: true` in the database descriptor. Without it, deleting a collection falls back to `db.transaction()`, fails with `SCHEMA_DELETE_ERROR` and leaves the collection in `deleting`. The prototype implements the guard (fence and drop) as one synchronous `ctx.storage.transactionSync()` callback, which gives real atomicity here. Fixed in the prototype on November 9.
4. **Cache provider.** Wraps the Astro Cloudflare provider's headers and sends `invalidate()` to the front Worker through a service binding or `ctx.exports`, since `ctx.cache` in the object is not the front Worker's cache.
5. **Scheduled work.** Cron triggers run on Workers, not in the object. Either the front Worker's `scheduled()` calls the object, or an alarm in the object runs `createScheduledHandler`. The live-site prototypes started with an alarm every 20 s that also rendered `/` (every third alarm ran maintenance). Since November 10, kevinkyburz.ch uses a 60 s alarm that only runs maintenance and the daily backup check.
6. **Keep-alive (optional).** See Performance. A setting, off by default.

### Requests that need special handling

- **Logged-in and admin requests** go to the object like any miss. Writes and reads are always on the primary, so read-your-writes needs no bookmark cookie.
- **Uploads and large bodies** pass through two hops. Check the body size limits on the RPC path and on `fetch` into the object.
- **WebSockets** (co-editing, #4680) use their own `EmDashRoom` objects. The site object must not proxy those upgrades. Room saves currently go "through its own Worker over the `exports` loopback"; in this mode they must reach the site object instead.
- **Sandboxed plugins**: `PluginBridge` reads `env.DB` directly today (#1623, design #4406, fix PR #4725). In this mode it must use the site object's database.
- **Site code that uses `env.DB` directly** (seen on scllauerz.ch) breaks. Document it and, if needed, offer a D1-shaped handle. A module-level handle cached at import time returned 404s in the prototype; fetch it per request.
- **`Server-Timing` and debug headers** from the object must not leak internals to the public; the prototype strips `do-*` entries in the front Worker.

### Operations

- **Export and import.** The site-transfer package already moves content between sites, but it excludes users, passkeys, sessions, API tokens, plugin state and secrets. Moving an existing D1 site into the object without losing logins needs a full SQLite copy. The prototype uses its own dump: `wrangler d1 export` fails on FTS5 tables, BLOB columns need hex encoding, FTS tables need `rebuild` after import, and order is tables, FTS triggers, data, indexes, other triggers, inside `transactionSync` with `PRAGMA defer_foreign_keys = ON`.
- **Backup and restore.** D1 Time Travel is not available. Durable Objects have point-in-time recovery for 30 days (`getBookmarkForTime`, `onNextSessionRestoreBookmark`). The prototype adds a daily dump to R2. Restore restarts the object mid-response (Cloudflare error 1101), but the restore succeeds.
- **No D1 console.** `wrangler d1 execute` doesn't work against an object. Operators need an authenticated SQL or export endpoint, or a CLI command.
- **`EMDASH_ENCRYPTION_KEY`** must carry the same value when moving a site, or encrypted plugin secrets become unreadable.

### Core integration surface

What a supported mode has to touch, so it doesn't become a second, drifting copy of the D1 path. Paths are on `main` as of November 10, 2026, except where an open pull request is named.

- **Database descriptor** (`packages/core/src/db/adapters.ts`). The new adapter returns a normal `DatabaseDescriptor` with `type: "sqlite"`. Capability flags need a decision each:
  - `supportsRequestScope`: not needed. There are no sessions or bookmarks; every query runs on the primary.
  - `supportsCoalescing`: not needed. Coalescing exists to save round trips, which in-process queries don't have.
  - `supportsCollectionDeletionGuard`: required. `media/usage/collection-deletion.ts` uses it for the atomic fence and drop. `EmDashDB.executeCollectionDeletionGuard` in `do-sql-class.ts` already implements it on DO SQLite and should be shared, not reimplemented.
  - `migrations` (deployment migration capability): D1 can run migrations at deploy time. Here migrations can only run inside the object, so either the capability is absent (runtime migrations, current prototype behavior) or a deploy step calls the object over RPC. Open question 15.
- **Shared SQL execution.** The prototype has its own dialect. Core should extract the execution logic from `EmDashDB` (`query`, `batchQuery`, `changes()`, the `D1Introspector`, PRAGMA handling) into a function that both the RPC class and the in-process dialect call. Then fixes to one (like #3633) reach both.
- **Virtual modules** (`packages/core/src/astro/integration/virtual-modules.ts`):
  - `virtual:emdash/wait-until` exports `waitUntil` from `cloudflare:workers` for the Cloudflare adapter. Inside a Durable Object, `after()` work must keep running after the response. Cloudflare documents that `ctx.waitUntil` in an object prevents eviction for up to 15 minutes; whether the imported `waitUntil` binds to the object's context needs a workerd test. If not, the site class provides its own implementation.
  - `virtual:emdash/scheduler`: scheduled publishing and maintenance must run in the object. Either the existing scheduler gets an alarm backend, or the front Worker's `scheduled()` calls the object.
- **Cache provider.** Route caching and `invalidate()` stay as they are in core. The new provider only changes where purges go (the front Worker). Purge rate limits apply as before.
- **Image transforms.** `/_image` and media files are sent with `public, max-age=0, must-revalidate` (`MUTABLE_MEDIA_CACHE_CONTROL`) so "Replace original" shows up at once. Behind the Workers Cache this means variants fall out of the edge cache quickly, and every miss becomes a render in the single object. On kevinkyburz.ch, variants warmed 20 minutes earlier were misses again (298 to 900 ms); with `CDN-Cache-Control: public, max-age=604800` set by the front Worker for `/_image`, all 869 variants of the site were hits on the next full check (one check right after warming, not a long-term measurement). Core needs a decision here (#4498): a long edge TTL with a purge on replace, or versioned media URLs.
- **Sandboxed plugins.** The plugin bridge must resolve the configured database instead of `env.DB`. This is the same fix #4406 and #4725 describe for D1 sites with a renamed binding, so this RFC depends on it rather than adding a second path.
- **Co-editing (#4680).** `EmDashRoomSite` (`packages/cloudflare/src/rooms/site.ts`, added by #4680) loads and saves through `withEmDashRuntime` in "its own Worker". In this mode that Worker is the front Worker, which has no EmDash runtime. Rooms must reach the site object instead, for example by exporting the room site entrypoint from the site Worker. Needs agreement with the co-editing owners before either lands.
- **Build output.** The Astro build produces one SSR entry. This mode needs two deployables: the site Worker (Astro bundle plus `EmDashSite`) and a front Worker without EmDash imports. Options are a prebuilt front Worker shipped in `@emdash-cms/cloudflare` (the prototype's approach, about 0.5 KB) or a second build entry. See open question 1.
- **Local dev.** `astro dev` must keep working without two Workers. The simplest path: in dev the adapter falls back to the existing `durableObjects()` or D1 path, and the two-Worker setup is only for `wrangler dev` and deploys. Needs a decision so dev and production don't diverge silently.
- **Tooling that assumes D1.** `emdash` CLI commands, `pnpm query-counts`, the site-transfer package, the acceptance harness and the e2e Cloudflare fixture. Each needs either support or an explicit "not in this mode".
- **Docs and templates.** A deployment guide page, a section in the database reference, and one template or demo variant. No change to the default templates.

## Compatibility and migration

- Additive: a new export and config option in `@emdash-cms/cloudflare`, minor bump. No change to `emdash` core schema or migrations.
- Existing D1 sites keep working. Moving a site is an explicit operator step: export from D1 (read-only), import into the empty object, verify on `workers.dev`, switch the route. Rollback is switching the route back, after exporting anything written since the switch, because writes after the switch exist only in the object.
- Moving from the existing `durableObjects()` adapter is a copy from `EmDashDB` into `EmDashSite`; both are SQLite in an object.
- Plugins that assume D1 bindings or `env.DB` need the same treatment as sandboxed plugins.

## Security and privacy

- **Ops endpoints** (export, import, restore, reset) expose the whole database including users and credentials. They need admin authentication, not a shared bearer token, or should exist only as CLI commands over the Cloudflare API. The prototype's token-in-file approach is not acceptable for core.
- **Import** must refuse a non-empty database (prototype returns 409) and validate the dump shape. Table and column names from a dump go into SQL, so they need `validateIdentifier()` or `sql.ref()`; the prototype interpolates them.
- **Front Worker** must forward client IP, `cf` properties and headers the auth and rate limiting code relies on, and must not let clients set internal headers (`x-ops-*`, warm markers) that change behavior.
- **Data location:** one object in one region means every byte of site data lives there. That can help with data residency (`jurisdiction: "eu"`), which D1 also offers. Document it.
- Backups in R2 contain user emails and password-equivalent material (passkey public keys, token hashes). Same care as D1 backups.

## Performance

- **Logged-out hot path:** query count is unchanged, but each query costs microseconds instead of about 17 ms. `pnpm query-counts` snapshots stay comparable.
- **Cold start of the object:** bundle load 81 ms, first render 388 ms CPU (65 to 120 ms warm). Splitting the bundle helps little; keeping the object warm helps a lot.
- **Idle eviction:** an object goes idle after about 10 s without work. Later samples measured 0.21 s after 5 min and 0.13 s after 10 min (one sample each, from Zurich), against 0.70 to 0.74 s earlier. Cloudflare documents reactivation on the last machine where possible (cloudflare/cloudflare-docs#35010), but a causal link to these samples is not established.
- **Keep-alive** (scllauerz.ch and linguadash.dev, and kevinkyburz.ch until November 10: `setInterval` plus an alarm every 20 s that renders `/`): keeps the same instance alive and the first render hot. Faster idle restarts may make it unnecessary. Cloudflare's [changelog of November 9](https://developers.cloudflare.com/changelog/post/2026-11-09-durable-objects-reactivation-placement/) says reactivated objects restart on the last machine where possible, without guaranteeing it. First samples on kevinkyburz.ch without warm render or `setInterval` (November 10, browser `fetch` with cache busting, small sequential samples): first request after the deploy that removed it 435 ms total (308 ms wall time in the object); five misses after a later deploy the same morning had a median of 118 ms (object wall time median 47 ms). Not yet evidence for p95 or long idle periods. It costs money (below) and makes deferred code updates useless (Failure handling). Proposal: off by default, documented as an option for sites that measure a need.
- **Single thread.** One object runs one request at a time between awaits. Measured on November 9 with a Node load generator from Zurich, 15 s per step, every request cache-busted with a random query string, so every request was a real render in the object:

  | Concurrency | Demo site (blog template) | kevinkyburz.ch (live, real content) |
  | ----------- | ------------------------- | ----------------------------------- |
  | 1           | n/a                       | 6 rps, p50 144 ms                   |
  | 10          | 81 rps, p50 116 ms        | 16 rps, p50 618 ms                  |
  | 40          | 122 rps, p50 323 ms       | 19 rps, p50 1.9 s                   |
  | 160         | 119 rps, p50 1.3 s        | 28 rps, p50 7.9 s, p95 11.4 s       |

  Zero errors and no `overloaded` responses at any level; requests queue and latency grows linearly. Throughput depends on how heavy a page is: the demo plateaus at about 120 renders per second, the live site (pages of 60 to 80 KB HTML with more components) at about 20. With the route cache warm, the same live site served 1,659 rps at 160 concurrency (all `HIT`, p50 71 ms), because hits never reach the object. Cloudflare's soft limit is 1,000 requests per second per object. A purge-everything, a deploy, or a crawler burst still sends misses straight to one thread, so a heavy site can queue for seconds. Overload handling (Failure handling) and serving stale entries matter more than raw throughput.

- **Distance.** All misses travel to one region. Measured first-miss TTFB from far away: Tokyo about 850 ms, Sao Paulo about 936 ms (still faster than D1 cold there). Independent data from [where.durableobjects.live](https://where.durableobjects.live) (a community probe that measures first-response time from Cloudflare colos to new Durable Objects in each region, `api/v3/data.json`, November 2026) shows that most of this is transit, not rendering:

  | Visitor colo | Object in `weur` | Object in a nearby region |
  | ------------ | ---------------- | ------------------------- |
  | Zurich       | 98 ms            | 48 ms (local)             |
  | Los Angeles  | 456 ms           | 78 ms (`wnam`)            |
  | Sao Paulo    | 503 ms           | 93 ms (`sam`)             |
  | Singapore    | 480 ms           | 50 ms (`apac`)            |
  | Mumbai       | 573 ms           | 79 ms (`apac`)            |
  | Tokyo        | 637 ms           | 29 ms (`apac`)            |
  | Sydney       | 828 ms           | 53 ms (`oc`)              |

  These numbers include creating the object, so a warm object is somewhat faster. They bound what regional read objects (open question 6) could gain for global sites and show that a European site pays about 0.5 s extra for a first miss from Asia, South America or Oceania. Workers Cache is tiered and uses the CDN cache, but it doesn't follow zone Cache Rules. In our test, an entry filled in Frankfurt hit in Paris, Vienna, Stockholm and Milan, and missed in Tokyo, Mumbai, Sydney, Sao Paulo, LA and Amsterdam, so far regions still reach the object on their first request.

- **Cost** (Workers Paid, October 2026 list price; this describes the kept-alive prototype). A kept-alive object is billed for duration at 128 MB: 460.8 GB-s per hour, about 331,776 GB-s per month. The plan includes 400,000 GB-s. One site: no extra cost. Three sites: about 995,000 GB-s, about $12.50 per month extra. Alarms every 20 s add about 130,000 requests per month per site. Without keep-alive, duration is billed only while the object is active. Cloudflare's own guidance lists "route every request, or every tenant, through one Durable Object" as an anti-pattern for control planes; for a single site behind a cache it fits, but the RFC should say why.

## Failure handling

- **Deploys and the 5-minute delay.** The default `code_update_strategy` is `{ "mode": "deferred", "max_delay": 300 }`: an active object keeps old code until it hibernates or 300 s pass. With keep-alive the object never hibernates, so we measured exactly 300 s of old code, then a random visitor paid the cold start (1.0 s TTFB). Without keep-alive, deferred works as intended but old code can still serve for up to 5 minutes, and the front Worker (new code) talks to an object on old code, so the RPC contract between them must stay backward and forward compatible. Proposal: `immediate` plus a warm-up request right after deploy. Cost: in-flight requests are aborted, including long uploads, imports and exports.
- **Restarts.** Code updates, runtime updates and placement decisions restart the object. Requests that touch storage during shutdown fail. The front Worker retries once (`getByName(name, { retry: { maxRetries: 1, timeoutMs: 5000 } })`, Wrangler 4.158 or later). Writes must not be retried blindly; check which requests are idempotent.
- **Overload.** Return 503 with `Retry-After` and serve stale cache entries where possible, instead of passing `overloaded` errors through.
- **Storage full** (10 GB per object): writes fail with `SQLITE_FULL`, reads and deletes still work. Surface it in the admin. Media stays in R2, so this is unlikely for typical sites.
- **Migration failures** (like the `SQLITE_AUTH` case) put the runtime into 30 s backoff and pages render empty with status 200. Add a startup check and a clear log line.
- **Observability.** `wrangler tail` on the object did not reliably show the decisive error in the prototype. Need logs from both Workers, and metrics for object restarts and RPC time.

## Verification

- Dialect unit tests with the workerd pool (`tests/workerd/**`, real DO SQLite): introspection skips `_cf_*` tables, `changes()` counts, transactions degrade like D1, the collection deletion guard fences and drops atomically, migrations apply from an older database.
- `after()` work started during a render in the object completes after the response (workerd test).
- Scheduled publishing fires and purges the front Worker's cache.
- Integration: full migration run on an empty object and on an imported older dump (linguadash went from 88 to 90 migrations).
- Export and import round trip on real data with FTS5 and BLOB columns; compare row hashes.
- Local dev: both Workers in one `wrangler dev` (`-c front -c site`); two separate processes only produce "Network connection lost" on DO RPC.
- Runtime on a real account: deploy with `immediate`, deploy with `deferred` with and without keep-alive, idle tests at 30 s to 10 min, publish then purge, scheduled publishing purge, PITR restore.
- Load test on one object: done for uncached renders (Performance). Admin latency under load was measured once on kevinkyburz.ch: with 40 concurrent uncached page requests running, `/_emdash/api/manifest` went from a median of 0.10 s to 1.6 s (max 3.5 s), because admin and visitors share the thread. Still open: a repeatable test on a larger site.
- Fixed-fixture benchmark: a separate isolated deployment with request-scoped SQL and buffered (not streamed) responses. Its internal render timings read zero and are not usable yet, and its cold-start parameter doesn't force an object restart, so cold-start claims need separate lifecycle evidence. It is not proof of production readiness.
- Manual (November 9): passkey registration and login, media upload, serving and deletion work through the object on the demo prototype; API tokens, MCP and publishing were checked on the live sites. Schema changes (add field, delete collection) work after the two dialect fixes in Detailed design, on the demo prototype and in a separate API-token test on kevinkyburz.ch. Sandboxed plugins fail: `PluginBridge` calls `this.env.DB.prepare` and there is no D1 binding (`Cannot read properties of undefined (reading 'prepare')`), as expected under Core integration surface. Still open: co-editing rooms, preview links.

## Rollout and implementation

Each step is a separate PR and useful on its own. Step 3 is the existing design #4406 and fix #4725, not new work in this RFC. Step 6 depends on co-editing (#4680) landing first.

1. Extract the shared DO SQLite execution code from `EmDashDB`; behavior-preserving refactor with the existing workerd tests.
2. In-process dialect on top of it, with workerd tests (introspection, `changes()`, transactions, deletion guard, migrations from an older database).
3. Plugin bridge resolves the configured database (#4406 / #4725). Benefits D1 sites with renamed bindings too.
4. `EmDashSite` class and the prebuilt front Worker in `@emdash-cms/cloudflare`, cache provider, scheduler backend, `after()` in the object. Marked experimental.
5. Export, import, backup and restore as authenticated admin or CLI operations.
6. Co-editing room saves against the site object, coordinated with #4680.
7. Docs (deployment guide, moving a site, trade-offs), marked experimental. One template or demo variant.
8. After real-world data: decide on keep-alive default, regional read objects, and whether templates should offer it.

## Alternatives

- **D1 with coalescing, Placement and KV object cache.** Measured above: helps warm requests, not cold isolates.
- **Existing `durableObjects()` adapter with coalescing.** Collapses about 17 reads into one RPC per turn, but the render still runs in a Worker that can be cold at every location, and sequential reads that depend on earlier results still pay one RPC each.
- **Cache warmers.** Hide regional misses for listed URLs only, don't warm `/_image`, and cost requests.
- **Containers.** Cold starts in seconds; always-on is more expensive.
- **Front Worker fetching from an origin hostname** so zone Cache Rules and Cache Reserve apply. Possible later, adds one hop.

## Drawbacks

- Two Workers (or one Worker with two roles) and a circular binding: the first deploy needs the object Worker without the service binding, then the front Worker, then the object Worker again.
- Old code for up to 5 minutes with `deferred`, or aborted requests with `immediate`. There is no option without one of the two.
- One region for all misses. Far-away first visitors pay the distance.
- One thread. A crawler burst or full purge can queue requests.
- No D1 Time Travel, no D1 console, no `wrangler d1 export`. Operators rely on PITR and EmDash's own tools.
- Another runtime mode to test and support in every release, including plugins, co-editing, preview and sandbox.
- Keep-alive costs money and works against Cloudflare's lifecycle model.

## Open questions

Questions 1, 2, 7, 8, 11 and 17 affect the public contract and must be resolved before acceptance. The others can be settled during implementation or after real-world data.

1. **One Worker or two?** Can the Astro build emit both entries, or should the front Worker be a separate tiny package? A single Worker with the 19 MB bundle in front loses most of the gain.
2. **API name and shape**: a database adapter (`cloudflareSite()`), an adapter option, or a separate entry (`@emdash-cms/cloudflare/site`)?
3. **Default `code_update_strategy`**: `immediate` plus warm-up, or `deferred` with a short `max_delay` (for example 30 s) and no keep-alive?
4. **Keep-alive**: drop it, or keep it as an option? kevinkyburz.ch runs without it since November 10; needs a week of RUM before deciding.
5. **Transactions**: keep D1 behavior, or use `transactionSync` where callbacks allow it?
6. **Regional read objects** (`locationHint`, or Cloudflare's DO read replication used by `EmDashDB`) that also render: worth it for global sites, and how do writes and read-your-writes work? The where.durableobjects.live numbers suggest about 0.4 to 0.8 s saved per first miss from far regions for a European site. A hand-built replica experiment on November 9 saved 75 to 210 ms per warm miss in Singapore and Sydney, but the first request took about 1 s and replicas served stale content after a publish until the next sync.
7. **Migration from D1**: a supported command (`emdash` CLI or admin), or document a manual path? Must keep users and passkeys.
8. **Ops surface**: which operations are admin API routes with permissions in `rbac.ts`, and which are CLI only?
9. **Limits**: the November 9 tests show a plateau of about 120 (demo) and 20 (kevinkyburz.ch) uncached renders per second without errors. What is acceptable for larger sites, and should the front Worker shed load or serve stale entries before latency reaches seconds?
10. **Body size and streaming** through two hops for uploads and exports.
11. **Plugins and site code using `env.DB`**: support a D1-shaped handle or declare unsupported?
12. **Cost guidance**: who documents the duration cost, and is it acceptable for the free plan?
13. **Does the Project Lead want this in core**, or as a documented community pattern? The DO architecture guide warns against one object per everything.
14. **`waitUntil` inside the object**: does `waitUntil` from `cloudflare:workers` bind to the object's context, or does the site class need its own `virtual:emdash/wait-until`?
15. **Deploy-time migrations**: leave the migration capability out (runtime migrations only), or add a deploy step that calls the object?
16. **Co-editing**: where does `EmDashRoomSite` live in this mode, and does #4680 need a hook for it before it ships?
17. **Local dev**: fall back to the D1 or `durableObjects()` path under `astro dev`, or require `wrangler dev` with both Workers?
18. **Other Cloudflare runtimes**: is there a Cloudflare product plan (for example running Workers code next to DO storage, or DO read replicas that can render) that makes this design obsolete? Better to know before core takes on the maintenance.
