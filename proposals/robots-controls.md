---
title: Separate robots controls per entry and site-wide robots defaults
type: feature-plan
status: proposed
authors:
  - Kevin Kyburz (@swissky)
  - Evgenii Zinner (@Evgenii-Zinner)
discussion: null
created: 2026-11-14
---

# Separate robots controls per entry and site-wide robots defaults

## Problem and user case

The SEO panel's **No index** switch emits `noindex, nofollow`. An editor who wants to keep a page out of search results, such as a thank-you page or a filtered archive, can't keep its links followable. A site also can't set directives that apply to every page, such as `max-image-preview:large`, which Google applies to web search, Images and Discover ([Robots meta tag specifications](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)). Today a theme has to pass `seo.robots` from every template to get either.

This plan builds on the SEO foundation RFC (design [#4765](https://github.com/emdash-cms/emdash/pull/4765)) for the SEO settings screen. It doesn't depend on the RFC's graph or URL resolution.

## Proposed behavior

- The editor's SEO panel shows two switches: **Hide from search results** (`noIndex`) and **Don't follow links** (`noFollow`).
- The SEO settings gain a **Robots defaults** section with `maxImagePreview` (`none`, `standard` or `large`), `maxSnippet` and `maxVideoPreview`.
- Core assembles one robots meta tag per page from the entry's switches and the site defaults.

An entry with **Hide from search results** on and **Don't follow links** off, on a site with `maxImagePreview: "large"`, renders:

```html
<meta name="robots" content="noindex, max-image-preview:large" />
```

An entry with neither switch on renders `max-image-preview:large` only. Without switches and defaults, core emits no robots meta tag, as today.

## Goals

- Editors set `noindex` and `nofollow` separately per entry.
- Administrators set site-wide `max-image-preview`, `max-snippet` and `max-video-preview` defaults.
- Existing entries keep their current output after the upgrade.

## Non-goals

- `nofollow`, `sponsored` or `ugc` on individual links in rich text. Design [#4792](https://github.com/emdash-cms/emdash/pull/4792) covers that.
- Changes to `robots.txt`, which keeps its current settings.
- `X-Robots-Tag` response headers.

## Interfaces and compatibility

`ContentSeo` gains `noFollow: boolean` next to `noIndex`. REST, MCP and the content API accept and return it like `noIndex`. `SeoSettings` gains:

```ts
interface SeoSettings {
	// existing fields unchanged
	defaultRobots?: {
		maxImagePreview?: "none" | "standard" | "large";
		/** -1 for no limit, 0 for no snippet. */
		maxSnippet?: number;
		/** Seconds; -1 for no limit. */
		maxVideoPreview?: number;
	};
}
```

A migration adds `seo_no_follow` (integer, default `0`) to `_emdash_seo` and sets it to `1` where `seo_no_index` is `1`, so every existing **No index** entry keeps emitting `noindex, nofollow`. The column check and the update are idempotent, so the migration restarts cleanly after a partial run on D1. Until the migration has run, code treats a missing column as `noFollow = noIndex`. Old code ignores the column during a rolling deploy.

A client that sends `noIndex` without `noFollow` leaves the stored `noFollow` unchanged. A new entry created with `noIndex: true` and no `noFollow` gets `noFollow: true`, which matches today's output for older clients.

New sites get `maxImagePreview: "large"`. Existing sites get no new default until an administrator sets one, so their output doesn't change on upgrade.

A template that passes `seo.robots` to `createPublicPageContext` keeps full control: its value replaces the assembled tag, as it replaces the default today. Staging sites keep emitting `noindex` on every page.

The entry's robots values arrive with the SEO row that the content query already joins, and the defaults with the cached site settings, so logged-out renders run no additional query.

## Errors and edge cases

- `maxSnippet` and `maxVideoPreview` accept integers from `-1` upward; other values are rejected with `VALIDATION_ERROR`.
- `noindex` doesn't remove the defaults, because Google ignores preview directives on pages it doesn't index and the output stays predictable.
- Entries with `noIndex` stay out of the sitemap and out of hreflang alternates, as today. `noFollow` alone changes neither.

## Verification

- Unit tests for assembling the tag from every switch combination, with and without defaults, and with a template `seo.robots` override.
- Dialect tests with `describeEachDialect` for the migration: an upgrade from a database with existing `noIndex` entries, and a restart after the first completed statement. A real D1 test in `tests/workerd`.
- An API test that a client sending only `noIndex` keeps the stored `noFollow`.
- `pnpm query-counts` shows no increase on logged-out routes.
- Playwright tests for both switches and the defaults section, including the Arabic layout, with screenshots in the UI PR.
