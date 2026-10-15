---
"emdash": patch
---

Fixes slower page loads for logged-out visitors on D1 with `session: "auto"` or `"primary-first"` and no `coalesce`. A session runs a request's queries one at a time, so EmDash's preload of site settings, menus, widget areas, and taxonomy terms for HTML pages delayed the page's own first query and added queries the page might never use. In that setup EmDash no longer preloads them; those queries run only when the page uses them. Sites with `coalesce: true` keep the preload, batched into one round trip.

New Cloudflare sites from the templates now use `d1({ binding: "DB", session: "auto", coalesce: true })`, so reads issued together share one D1 round trip, with or without read replication. To get the same on an existing site, set `session: "auto"` (or `"primary-first"`) and `coalesce: true` in its `d1()` call; `coalesce` has no effect without a session. `coalesce` is experimental: a read and a write started together may run write-first, so await a read before a write that must not affect it.
