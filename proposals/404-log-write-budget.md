---
title: Limit 404 log writes during request floods
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
discussion: null
created: 2026-11-20
---

# Limit 404 log writes during request floods

## Problem and user case

Every request that ends in a 404 writes to `_emdash_404_log`: the redirect middleware runs an upsert by path in `after()`, which inserts a row or increments `hits`. On a site behind a cache this is one database write per miss, on the primary, for every visitor.

Vulnerability scanners request hundreds of random paths in a few seconds (`/.env`, `/.git/config`, `/wp-login.php`, `/graphql`, random strings). Paths that match no route have no route-cache context, so each one reaches the Worker, renders the 404 page and writes a log row. On a production EmDash site running on a Durable Object database, a scanner caused about 130 uncached 404 renders in 10 seconds, and the database object was reset 34 times while it lasted. Each write goes to the single primary, so the writes compete with every other request that needs it.

The scanner's rows have no value to the site owner, and they push useful entries out of the log: it keeps 10,000 paths and drops the least recently seen. Some sites don't use the 404 log at all, but there is no way to turn it off.

## Proposed behavior

### Write budget

Each server instance (a Worker isolate, or a Node process) logs at most 60 misses per minute. Misses beyond that are answered as before but not written to the log until the next minute starts. Normal traffic stays well below this: a site needs more than one miss per second on the same instance before anything is skipped.

The budget is a fixed window counter kept on `globalThis`, like other module-scope state in core. It needs no database access and no configuration. It doesn't change what the visitor receives, and it doesn't change the logged-out query count, because the write already runs after the response in `after()`.

When the budget skips its first miss in a window, EmDash logs one warning for that window, for example `[emdash:redirects] 404 log write budget reached; skipping further misses for this minute`.

### Option to turn the log off

`emdash({ notFoundLog: false })` stops logging misses entirely. The default, `true`, keeps the budgeted log. With the log off, the **404 Errors** tab shows the existing entries and a short note that logging is turned off in the site configuration. Existing entries stay until they are deleted or evicted.

```js
// astro.config.mjs
emdash({
	database: d1({ binding: "DB" }),
	notFoundLog: false,
});
```

## Goals

- A burst of 404 requests causes at most 60 log writes per minute per server instance.
- Sites can turn off 404 logging.
- Normal traffic is logged as completely as today.
- The visitor's response, redirect handling and logged-out query counts are unchanged.

## Non-goals

- Avoiding the 404 render and its read queries during a flood. Blocking scanners before the Worker, with a WAF or rate-limiting rule, does that; the docs point to it.
- A global budget across instances. Each isolate counts on its own, so the total depends on how many isolates serve the burst.
- Filtering paths by shape (for example, skipping `/.env`). Any list misses some scanners and drops real misses.
- Making the budget configurable. It can become an option if a site shows a need.
- Logging redirect hits differently. `recordHit` for matched redirects is unchanged.

## Interfaces and compatibility

- New optional `notFoundLog?: boolean` on the `emdash()` options, validated with the other options in `config/options-schema.ts`. The default keeps logging on, so existing sites need no change.
- The admin's 404 tab reads whether logging is on from the admin manifest (`/_emdash/api/manifest`), next to existing flags such as `coEditing`, and shows the note. No new route.
- No change to stored data, the `_emdash_404_log` schema, its 10,000-row cap or the cleanup job.
- During a flood, `hits` counts for the affected paths are lower than the real number of requests. The docs say so.
- Docs: the "Redirects and the 404 log" section of the SEO guide and the configuration reference describe the budget and the option. One `emdash` changeset (minor) and one `@emdash-cms/admin` changeset (minor) for the note.

## Errors and edge cases

- **Write failures:** unchanged. A failed upsert is logged and doesn't affect the response. A failed write still counts against the budget, so a failing database isn't retried faster.
- **Concurrent requests:** the counter is incremented before the write is scheduled, so overlapping requests on one instance can't exceed the budget.
- **Window boundary:** a burst that spans two windows can write up to 120 rows within a short time. The budget still bounds writes over any longer period.
- **Prerendered pages:** misses on prerendered pages are logged without referrer and user agent today. They count against the same budget.
- **Node:** one process is one instance, so the budget applies per process. A Node site behind a cache sees the same protection.
- **Option off:** no 404 log writes and no budget bookkeeping. Redirects, `410` and `451` rules still work.

## Verification

- Unit test for the budget with controlled time: the 61st miss in a window isn't written, the first miss of the next window is, and the warning is printed once per window in which misses were skipped.
- Middleware test on SQLite: 70 different missed paths within one minute produce 60 rows; a repeated path below the budget still increments `hits`; responses and status codes are identical with and without the budget.
- Middleware test with `notFoundLog: false`: no rows are written, and redirect and gone rules still apply.
- `pnpm query-counts`: no change on any route.
- Admin: with the option off, the 404 tab shows the note, checked in English and Arabic. Screenshot in the implementation PR.
- Manual check on a test Worker: a burst of 300 random paths writes at most 60 rows per isolate per minute.

## Open questions

- Is 60 per minute the right default? It stays above normal traffic for small and medium sites and cuts the measured scanner burst (about 780 misses per minute) by more than 90 %.
- Should the option also accept `"routes"`, which logs only misses on matched routes (a content miss on `/posts/[slug]`) and skips unmatched paths? It removes most scanner writes, but also the old WordPress URLs that site owners use the log for after a migration.
