---
"emdash": patch
---

Fixes the JSON-LD that core emits on public pages, which published nodes nothing could reference. `BlogPosting`, its `publisher`, and `WebSite` had no `@id`, so an Organization graph describing the site — from a plugin or written into a template — stood beside the article's publisher as a second, competing organisation instead of merging with it. Article pages carried two organisations, and the fuller one was not the article's publisher.

Each of the three nodes now carries an `@id`: `<canonical>#article`, `<origin>/#organization`, and `<origin>#website`. The publisher keeps its `@type` and `name`, so a site publishing no Organization graph of its own is unaffected.

Sites already emitting an Organization graph should confirm its `@id` is `<origin>/#organization` — with the slash before the fragment. `https://example.com#organization` is a different IRI, and a mismatch produces two organisations rather than one.
