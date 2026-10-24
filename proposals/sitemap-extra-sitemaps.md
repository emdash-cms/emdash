---
title: List extra sitemaps in the built-in sitemap index
type: feature-plan
status: proposed
authors:
  - Chiji1108 (@Chiji1108)
discussion: null
created: 2026-10-22
---

# List extra sitemaps in the built-in sitemap index

## Problem and user case

The built-in `/sitemap.xml` lists one sitemap per collection. Pages that are not entries, such as Astro routes in `src/pages/` (a home page, an archive, an about or access page), have no way in (#3426). The only option is to replace `sitemap.xml` with a route of one's own. That route then has to list every collection sitemap by hand, follow pagination (`/sitemap-{collection}-{n}.xml`), and do without `<lastmod>`. Our clinic site does this today with a hard-coded list of collections.

## Proposed behavior

A new integration option lists extra sitemaps in the index, after the collection sitemaps:

```js
emdash({
	sitemap: { sitemaps: ["/sitemap-pages.xml"] },
});
```

The site serves `/sitemap-pages.xml` from its own route, with whatever URLs, dates, and extensions it needs. Paths resolve against the same origin as the collection sitemaps: the Site URL setting, then `siteUrl`, then the environment variable, then the request. Absolute http(s) URLs are listed as given.

## Goals

- Sites can add pages outside collections to the sitemap without replacing EmDash's index.
- EmDash keeps owning the collection sitemaps, their pagination, and their `<lastmod>`.

## Non-goals

- Discovering Astro routes automatically.
- Generating a sitemap from a list of URLs. Per-URL dates, images, and alternates are the site's to know, and a generated name could collide with `sitemap-[collection].xml`.
- Changing which entries the collection sitemaps include.

## Interfaces and compatibility

Adds `sitemap?: { sitemaps?: string[] }` to the integration options and passes it to the runtime config. Without the option, the index is unchanged. A site that already replaces `sitemap.xml` keeps its own route.

## Errors and edge cases

- The build fails when `sitemaps` is not an array, or when an entry is neither a path starting with `/` nor an http(s) URL. A protocol-relative `//host/...` entry also fails.
- Paths are stored percent-encoded, and URLs are stored normalized.
- Extra sitemaps have no `<lastmod>`, because EmDash cannot know it.
- A site route whose name a collection sitemap also uses, such as `sitemap-pages.xml` on a site with a `pages` collection, shadows that collection's sitemap. The docs warn about it.
- Search engines accept a sitemap on another host only after the site verifies that host. The docs say so.
- The index still lists the extra sitemaps when no collection has listed entries.

## Verification

- The index lists the collection sitemaps, then the configured paths and URLs, XML-escaped.
- The index lists the configured sitemaps when no collection has listed entries.
- The option reaches `locals.emdash.config`, with paths percent-encoded and URLs normalized.
- Invalid entries and a non-array value fail the integration setup.
- Prototype with these tests: [`prototype/sitemap-extra-sitemaps`](https://github.com/Chiji1108/emdash/commit/01c0eebbfa969f93b169a6a3b75cbf64254065fd).

## Open questions

- Should a plugin or theme also be able to contribute extra sitemaps, as the Blog Starter's archive in #3426 would need? This plan covers site configuration only.
