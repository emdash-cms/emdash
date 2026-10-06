---
"emdash": patch
---

Fixes slower browser page loads on D1 with `session: "auto"` or `"primary-first"` and no `coalesce`. A session runs a request's queries one at a time, so EmDash's preload of site settings, menus, widget areas, and taxonomy terms for HTML pages delayed the page's own first query and added several sequential queries the page might never use. EmDash now skips that preload when the database runs a request's queries one at a time. Sites with `coalesce: true` keep it.

If your D1 database has read replication enabled, consider the experimental `d1({ binding: "DB", session: "auto", coalesce: true })`, so reads issued together share a round trip. With `coalesce`, a read and a write started together may run write-first, so await a read before a write that must not affect it. Without read replication, sessions bring no benefit: remove the `session` option so queries go straight to the primary and run in parallel.
