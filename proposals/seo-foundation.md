---
title: "SEO foundation: identity, connected structured data, canonical URLs and discovery"
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
  - Evgenii Zinner (@Evgenii-Zinner)
champion: Kevin Kyburz (@swissky)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4621
  - https://github.com/emdash-cms/emdash/discussions/4614
  - https://github.com/emdash-cms/emdash/discussions/2990
created: 2026-11-07
---

# SEO foundation: identity, connected structured data, canonical URLs and discovery

## Summary

EmDash gets one model for who publishes a site, who writes its content, and which URL represents each page. Every search-facing output reads from that model: the canonical link, Open Graph tags, JSON-LD, sitemaps and change notifications to search engines.

The RFC is delivered in four phases. Each phase ships on its own and leaves a site in a consistent state.

1. **Identity.** Site settings describe the publisher as an `Organization` or a `Person`, with an open list of profile links. Bylines get their own profile links. Each link controls separately whether it appears in Schema.org `sameAs` and whether it is emitted as `<link rel="me">`. The six `site:social` keys keep working.
2. **Connected graph and canonical URLs.** `EmDashHead` emits one JSON-LD `@graph` whose nodes reference each other by `@id`: publisher, `WebSite`, `WebPage`, the article, its authors, breadcrumbs and the primary image. Themes and plugins replace or extend single nodes instead of the whole block. Every page gets a self-referencing absolute canonical URL from the resolver that also produces sitemap and graph URLs.
3. **Discovery.** The sitemap index accepts additional sitemap providers. Core ships Google News and video sitemap providers and sends IndexNow notifications on publish, update, unpublish and delete.
4. **Editorial tooling (optional).** Search and social previews in the editor, separate robots controls per entry, redirect import, and content checks that warn without blocking a save.

Structured data that Google no longer uses for search features is out of scope: FAQ, HowTo and the sitelinks search box.

## Problem and user case

### Publisher identity is incomplete

The generated `BlogPosting` names its publisher by site title only, and `WebSite` has no publisher. Nothing in core describes the organization or person behind a site. [Discussion #4614](https://github.com/emdash-cms/emdash/discussions/4614) runs several company sites and adds `Organization` data with address, served areas and profiles through a `page:metadata` plugin, because site settings have nowhere to store it and editors can't change plugin options.

### Social links are a closed list

`site:social` accepts six keys (`twitter`, `github`, `facebook`, `instagram`, `linkedin`, `youtube`), and the settings schema strips everything else. [Issue #4155](https://github.com/emdash-cms/emdash/issues/4155) and [Discussion #4131](https://github.com/emdash-cms/emdash/discussions/4131) need regional platforms such as WeChat and Weibo, some of which identify an account by handle or ID rather than by a public URL. [Discussion #4621](https://github.com/emdash-cms/emdash/discussions/4621) and design [#4714](https://github.com/emdash-cms/emdash/pull/4714) ask for an open list with `rel="me"` verification.

### Authors have no identity in structured data

Article markup lists the author as `{ "@type": "Person", "name": … }`. Bylines already store a display name, bio, avatar and website URL, but none of it reaches JSON-LD, and a byline has no place for profile links. Google recommends a `url` or `sameAs` for every author so it can tell authors apart, and recommends listing every author separately ([Article structured data: author markup best practices](https://developers.google.com/search/docs/appearance/structured-data/article#author-bp)).

### Structured data cannot be extended in parts

Core emits one JSON-LD block under the contribution ID `primary`. A theme that needs `NewsArticle` instead of `BlogPosting`, or an `ImageObject` logo, must replace the whole block or ship a second one with a conflicting `@type` ([issue #4471](https://github.com/emdash-cms/emdash/issues/4471), [Discussion #2990](https://github.com/emdash-cms/emdash/discussions/2990)).

### Canonical URLs depend on the template

A page has a canonical link only when its template passes `canonical` to `createPublicPageContext`, or when an editor sets one in the SEO panel. Sitemap `<loc>`, `og:url`, JSON-LD `url` and slug-change redirects derive their URLs separately. When these disagree, the site sends conflicting signals, which Google's guidance tells sites to avoid: "Don't specify different URLs as canonical for the same page using different canonicalization techniques" ([How to specify a canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)). Sites with runtime locale prefixes already get sitemap URLs that redirect ([issue #2697](https://github.com/emdash-cms/emdash/issues/2697)).

### Search engines learn about changes late

Sitemaps list collection entries only, so Astro routes such as a blog archive are missing ([issue #3426](https://github.com/emdash-cms/emdash/issues/3426), design [#4341](https://github.com/emdash-cms/emdash/pull/4341)). Publishers have no news or video sitemap. Search engines that support IndexNow are not told when content changes ([issue #4529](https://github.com/emdash-cms/emdash/issues/4529)).

### Robots controls are coupled

The SEO panel's **No index** switch emits `noindex, nofollow`. An editor who wants to keep a page out of the index can't keep its links followable, and a site can't allow large image previews, which Google applies to web search, Images and Discover ([Robots meta tag specifications](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)).

## Example

A company site with one author. After Phase 1 the site identity is stored like this:

```json title="site:identity"
{
	"type": "Organization",
	"name": "Example Studio AG",
	"logo": { "mediaId": "01J9ZK6V1Q" },
	"description": "Design studio in Zurich.",
	"address": {
		"streetAddress": "Bahnhofstrasse 1",
		"postalCode": "8001",
		"addressLocality": "Zürich",
		"addressCountry": "CH"
	},
	"links": [
		{
			"id": "l1",
			"platform": "linkedin",
			"value": "https://www.linkedin.com/company/example-studio",
			"sameAs": true,
			"relMe": false
		},
		{
			"id": "l2",
			"platform": "mastodon",
			"value": "https://mastodon.social/@examplestudio",
			"sameAs": true,
			"relMe": true
		},
		{
			"id": "l3",
			"platform": "wechat",
			"value": "examplestudio_ch",
			"sameAs": false,
			"relMe": false
		}
	]
}
```

The byline Jane Doe has one GitHub profile link marked `sameAs`, and the site has an author archive at `/authors/jane-doe/`. An article page emits one graph:

```json
{
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "Organization",
			"@id": "https://example.com/#organization",
			"name": "Example Studio AG",
			"url": "https://example.com/",
			"logo": { "@id": "https://example.com/#logo" },
			"address": {
				"@type": "PostalAddress",
				"streetAddress": "Bahnhofstrasse 1",
				"postalCode": "8001",
				"addressLocality": "Zürich",
				"addressCountry": "CH"
			},
			"sameAs": [
				"https://www.linkedin.com/company/example-studio",
				"https://mastodon.social/@examplestudio"
			]
		},
		{
			"@type": "ImageObject",
			"@id": "https://example.com/#logo",
			"url": "https://example.com/_emdash/api/media/file/logo.png",
			"width": 512,
			"height": 512
		},
		{
			"@type": "WebSite",
			"@id": "https://example.com/#website",
			"url": "https://example.com/",
			"name": "Example Studio",
			"inLanguage": "de-CH",
			"publisher": { "@id": "https://example.com/#organization" }
		},
		{
			"@type": "WebPage",
			"@id": "https://example.com/blog/launch/#webpage",
			"url": "https://example.com/blog/launch/",
			"name": "We launched",
			"inLanguage": "de-CH",
			"isPartOf": { "@id": "https://example.com/#website" },
			"breadcrumb": { "@id": "https://example.com/blog/launch/#breadcrumb" },
			"primaryImageOfPage": { "@id": "https://example.com/blog/launch/#primaryimage" }
		},
		{
			"@type": "BlogPosting",
			"@id": "https://example.com/blog/launch/#article",
			"headline": "We launched",
			"datePublished": "2026-11-02T08:00:00+01:00",
			"dateModified": "2026-11-03T09:20:00+01:00",
			"mainEntityOfPage": { "@id": "https://example.com/blog/launch/#webpage" },
			"image": { "@id": "https://example.com/blog/launch/#primaryimage" },
			"author": [{ "@id": "https://example.com/authors/jane-doe/#person" }],
			"publisher": { "@id": "https://example.com/#organization" }
		},
		{
			"@type": "Person",
			"@id": "https://example.com/authors/jane-doe/#person",
			"name": "Jane Doe",
			"url": "https://example.com/authors/jane-doe/",
			"sameAs": ["https://github.com/janedoe"]
		},
		{
			"@type": "ImageObject",
			"@id": "https://example.com/blog/launch/#primaryimage",
			"url": "https://example.com/_emdash/api/media/file/launch.jpg",
			"width": 1600,
			"height": 900
		},
		{
			"@type": "BreadcrumbList",
			"@id": "https://example.com/blog/launch/#breadcrumb",
			"itemListElement": [
				{ "@type": "ListItem", "position": 1, "name": "Home", "item": "https://example.com/" },
				{ "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://example.com/blog/" },
				{ "@type": "ListItem", "position": 3, "name": "We launched" }
			]
		}
	]
}
```

The head of the same page contains:

```html
<link rel="canonical" href="https://example.com/blog/launch/" />
<link rel="me" href="https://mastodon.social/@examplestudio" />
<meta name="robots" content="max-image-preview:large" />
<meta property="og:url" content="https://example.com/blog/launch/" />
```

A plugin adds properties to the article node from its `page:metadata` hook, instead of replacing the whole block:

```ts title="src/plugins/article-section.ts"
import type { PageMetadataHandler } from "emdash";

export const pageMetadata: PageMetadataHandler = (event) => {
	if (event.page.content?.collection !== "posts") return null;
	return {
		kind: "jsonld-node",
		id: "article",
		mode: "merge",
		node: { articleSection: "Company news" },
	};
};
```

The WeChat ID appears in neither `sameAs` nor `rel="me"`, because it is not a URL. Themes can still render it from `getSiteIdentity()`.

## Goals

- Site settings describe the publisher as an `Organization` or a `Person`, editable in the admin and through REST and MCP.
- Site and bylines keep an open list of profile links. Each link controls `sameAs` and `rel="me"` separately, and a link can hold a handle or ID that isn't a URL.
- Existing `site:social` values keep rendering, and themes that read `settings.social` keep working without changes.
- Each page emits at most one core JSON-LD graph whose nodes reference each other by stable `@id` values.
- Themes and plugins can replace, merge into or remove a single graph node.
- Every indexable page has one absolute, self-referencing canonical URL, and the sitemap, `og:url` and graph use that same URL.
- Plugins and sites can add sitemaps to the sitemap index.
- Sites can publish a Google News sitemap and a video sitemap.
- Sites can notify IndexNow when public URLs change, without delaying the editor's save or publish.
- `noindex` and `nofollow` can be set separately, and sites can set a default `max-image-preview`.
- Logged-out page renders run no additional database queries.
- Every new schema property has a source in Google Search Central documentation or the Schema.org vocabulary.

## Non-goals

- FAQ, HowTo and sitelinks search box markup. Google removed these features from search results ([Search Central documentation updates](https://developers.google.com/search/updates)).
- Product, Recipe, Event, JobPosting, LocalBusiness opening hours and other vertical types. Plugins add them through graph nodes.
- A keyword score, readability score or other single rating of content quality. Phase 4 checks report concrete, fixable problems only.
- Server-side AI content generation.
- Replacing hreflang output, which already renders from translations.
- Defining an entry's public URL for routes a URL pattern can't express. [Discussion #4336](https://github.com/emdash-cms/emdash/discussions/4336) covers that. This RFC consumes whatever resolver that work produces.
- External redirect targets ([issue #3821](https://github.com/emdash-cms/emdash/issues/3821)).
- Guaranteeing indexing or rich results. Google treats canonical URLs as a hint and doesn't guarantee that structured data produces a search feature ([General structured data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)).

## Detailed design

### Phase 1: identity

#### Profile links

A profile link is the shared shape for site and byline links:

```ts
interface ProfileLink {
	/** Stable ID within its list, generated by the admin. */
	id: string;
	/** Platform key from the built-in registry, or "custom". */
	platform: string;
	/** Display label. Required for "custom", optional otherwise. */
	label?: string;
	/** URL, handle or account ID, as the editor entered it. */
	value: string;
	/** Include in Schema.org `sameAs`. Applies only when `value` resolves to an https URL. */
	sameAs: boolean;
	/** Emit `<link rel="me">`. Applies only when `value` resolves to an https URL. */
	relMe: boolean;
}
```

The platform registry lives in core. It maps a key to a display name, an icon name and, optionally, a function that builds a profile URL from a handle, for example `@example` on `twitter` to `https://x.com/example`. Platforms without a public profile URL, such as `wechat`, have no builder, so their values never reach `sameAs` or `rel="me"`. The six legacy platforms also get the reverse function, which extracts the handle from a profile URL, so the legacy sync can write values in the form `site:social` has always held. Adding a platform to the registry is a non-breaking change.

Validation at the REST and MCP boundary:

- `value` is trimmed, non-empty and at most 2048 characters.
- A value that parses as a URL must use `https:` or `http:`. Other schemes, such as `javascript:` or `data:`, are rejected with `VALIDATION_ERROR`.
- `sameAs` and `relMe` are stored as the editor set them. Output ignores them for values that don't resolve to an `https:` URL, and the admin says so next to the switch. Storing the intent keeps it when the editor later corrects the value.
- A list holds at most 50 links, and `id` values are unique within a list.

`sameAs` and `relMe` are separate switches because they mean different things. `sameAs` states that the profile describes the same entity; Google documents it for `Organization` and for article authors ([Organization](https://developers.google.com/search/docs/appearance/structured-data/organization), [Article](https://developers.google.com/search/docs/appearance/structured-data/article)). `rel="me"` lets a platform such as Mastodon verify that the site links to the profile. A company profile on a platform that doesn't verify links needs `sameAs` without `rel="me"`.

#### Site identity

A new setting, `site:identity`, stores the publisher:

```ts
interface SiteIdentity {
	type: "Organization" | "Person";
	/** Legal or display name. Falls back to the site title. */
	name?: string;
	alternateName?: string;
	description?: string;
	/** Falls back to `site:logo`. */
	logo?: MediaReference;
	/** Absolute https URL used as the entity's `url`. Defaults to the site URL. */
	url?: string;
	email?: string;
	telephone?: string;
	address?: {
		streetAddress?: string;
		postalCode?: string;
		addressLocality?: string;
		addressRegion?: string;
		/** ISO 3166-1 alpha-2 */
		addressCountry?: string;
	};
	/** ISO 3166-1 alpha-2 codes or region names. */
	areaServed?: string[];
	foundingDate?: string;
	/** Organization only. */
	identifiers?: Array<{ propertyID: string; value: string }>;
	/** Organization only: absolute https URLs of policy pages. */
	policies?: {
		publishingPrinciples?: string;
		correctionsPolicy?: string;
		ethicsPolicy?: string;
		diversityPolicy?: string;
		ownershipFundingInfo?: string;
		actionableFeedbackPolicy?: string;
	};
	/** Person only. */
	jobTitle?: string;
	/** Person only: the byline that represents the site owner. */
	bylineId?: string;
	links: ProfileLink[];
}
```

Each property maps to the Schema.org property of the same name. The organization properties are the ones Google lists for `Organization` ([Organization structured data](https://developers.google.com/search/docs/appearance/structured-data/organization)); `identifiers` map to `vatID`, `taxID`, `leiCode` and `duns` there, and other `propertyID` values become `identifier` entries. The policy properties come from Schema.org ([publishingPrinciples](https://schema.org/publishingPrinciples)). Google doesn't document them as a search feature, so the admin shows them in a collapsed section for news publishers.

Settings, REST and MCP read and write `identity` like the other `site:*` keys, behind the existing `settings:manage` permission. `site:identity` is added to `PORTABLE_SETTING_NAMES`, so site transfer exports and imports it.

The admin warns when the logo is smaller than 112 x 112 pixels or not in a format Google supports, following Google's logo guidelines. The save still succeeds.

When `type` is `Person` and `bylineId` is set, the publisher and that byline's author node are one node with one `@id`, so a personal blog doesn't describe its owner twice.

Themes read the resolved identity through a new `getSiteIdentity()` export. It returns the stored value, or a value synthesized from legacy settings, with media references resolved. It reads the cached site settings and runs no query of its own.

#### Byline identity

Bylines get two built-in columns on `_emdash_bylines`:

- `profile_links`: JSON array of `ProfileLink`, nullable.
- `job_title`: text, nullable.

Both are per locale like `bio`, because a job title is translated and a byline may link a different profile per language. The admin offers **Copy to all translations** so editors don't enter the same links several times.

Columns keep the data in the byline row that `getContentBylines` and `getContentBylinesMany` already select, so author nodes need no custom-field hydration. The existing `websiteUrl` stays; it becomes the author's `url` when the site has no author archive.

#### Head output

`<link rel="me">` is emitted for every site link with `relMe` that resolves to an https URL, and on an author archive also for that byline's links. `PageMetadataLinkRel` gains `"me"`, so plugins can contribute such links.

### Phase 2: connected graph and canonical URLs

#### URL resolution

Phase 2 depends on one function that returns an entry's public URL:

```ts
function resolveEntryUrl(entry: {
	collection: string;
	id: string;
	slug: string | null;
	locale: string;
	data: Record<string, unknown>;
}): Promise<string | null>;
```

It wraps today's `resolveLocalizedContentRoutePath` (URL pattern, locale prefix, trailing slash) and prefixes the public site URL from `getPublicSiteUrl()`. When [Discussion #4336](https://github.com/emdash-cms/emdash/discussions/4336) adds a way to override entry URLs, the override plugs into this function. The canonical link, `og:url`, graph URLs and `@id` values, breadcrumbs, sitemap `<loc>` and IndexNow all call it, and none of them builds an entry URL another way.

A new site setting, `seo.authorUrlPattern` (for example `/authors/{slug}/`), gives bylines a public archive URL. When it is unset, author nodes use the byline's `websiteUrl` as `url` and fall back to an `@id` under the site URL (`{siteUrl}/#/schema/person/{translationGroup}`), so the same author keeps one identity across pages and locales.

When `site:url` is unset, URLs fall back to the request origin, as today. The SEO settings screen shows a warning while it is unset, because preview and production hosts can differ.

#### Canonical rules

These rules follow Google's canonicalization guidance ([How to specify a canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [What is canonicalization](https://developers.google.com/search/docs/crawling-indexing/canonicalization)):

1. Every content page emits `<link rel="canonical">`. Without an editor override, it points at the page itself. Google: "Do include a rel="canonical" link on the canonical page itself".
2. The URL is absolute and has no fragment. Google asks for absolute rather than relative paths and generally doesn't support fragments in canonical URLs. Graph `@id` values keep their fragments, because they identify nodes, not pages.
3. Query parameters are removed, so `?utm_source=…` and `?gclid=…` variants point at the clean URL. Pagination is the exception: page 2 of an archive is its own canonical and doesn't point at page 1. Templates pass the page number in the page context.
4. A translation points at itself, never at the default locale. Google asks hreflang sites to use a canonical page in the same language. hreflang alternates keep coming from `getHreflangAlternates`.
5. An editor's override in the SEO panel resolves to an absolute URL, as today. When it points at another URL, the entry is left out of the sitemap and out of IndexNow, so the site never submits a URL whose page names a different canonical.
6. Core emits the canonical in the HTML head only, not also as a `Link` header. Google recommends choosing one method because two can disagree.
7. A page with `noindex` keeps its self-referencing canonical. Google advises against using `noindex` to choose a canonical.
8. Custom Astro routes pass `canonical` to `createPublicPageContext`, as today. When they don't, core uses the request URL without query string, under the same rules.

`og:url` always equals the canonical URL. Google treats a canonical as a hint, so these rules can only make the site's own signals consistent.

#### Graph assembly

Core builds the graph from node builders. Each builder receives the resolved page context and returns a node or `null`.

| Node key                    | Schema.org type                                                                                          | Emitted when                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `publisher`                 | `Organization` or `Person`                                                                               | always; the name falls back to the site title                             |
| `logo`                      | `ImageObject`                                                                                            | the publisher has a logo                                                  |
| `website`                   | `WebSite`                                                                                                | always                                                                    |
| `webpage`                   | `WebPage`; `CollectionPage` on archives; `ProfilePage` on author archives; `SearchResultsPage` on search | always                                                                    |
| `article`                   | `BlogPosting` by default; `Article` or `NewsArticle` per collection                                      | `pageType` is `article`                                                   |
| `author:{translationGroup}` | `Person`, or `Organization` for a byline marked as an organization                                       | each credited byline of an article; the `mainEntity` of an author archive |
| `primaryimage`              | `ImageObject`                                                                                            | the page has an image                                                     |
| `breadcrumb`                | `BreadcrumbList`                                                                                         | the page context has breadcrumbs                                          |
| `video:{n}`                 | `VideoObject`                                                                                            | Phase 3; an entry contains a video with the properties Google requires    |

`@id` values:

- Site nodes: `{siteUrl}/#organization` or `{siteUrl}/#person`, `{siteUrl}/#website`, `{siteUrl}/#logo`. The organization ID matches the one `BlogPosting.publisher` already uses.
- Page nodes: `{canonical}#webpage`, `{canonical}#article`, `{canonical}#breadcrumb`, `{canonical}#primaryimage`. The article ID matches today's `BlogPosting` `@id`.
- Authors: `{authorArchiveUrl}#person` when `seo.authorUrlPattern` is set, otherwise the fallback described above.

Properties per node come from Google's documentation for the matching feature:

- **Article:** `headline`, `datePublished`, `dateModified`, `image`, and every author listed separately with `url` or `sameAs`. The author `name` holds only the name; `jobTitle` carries the title ([Article: author markup best practices](https://developers.google.com/search/docs/appearance/structured-data/article#author-bp)). Dates are ISO 8601 with a time zone offset, computed from the site time zone.
- **Organization:** the properties of `SiteIdentity`, with `sameAs` from links that have `sameAs` set and resolve to https URLs. `sameAs` is never set on `WebSite`.
- **ProfilePage:** `mainEntity` points at the author node, with `dateCreated` and `dateModified` from the byline ([Profile page structured data](https://developers.google.com/search/docs/appearance/structured-data/profile-page)).
- **BreadcrumbList:** `ListItem` entries with `position`, `name` and `item`. The last item may omit `item` ([Breadcrumb structured data](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)). Google shows breadcrumbs on desktop results only. Core emits the node on every page with breadcrumbs, because it also describes the page's position in the site.
- **Paywalled content:** a template that gates part of a page passes `access: { free: false, selector: ".paywall" }` in the page context. The article then gets `isAccessibleForFree: false` and a `hasPart` `WebPageElement` with that CSS selector ([Subscription and paywalled content](https://developers.google.com/search/docs/appearance/structured-data/paywalled-content)). Without `access`, core emits nothing for paywalls.
- **Images:** the graph's primary image and `og:image` resolve to the same URL, because Google uses both as sources for thumbnails in Search and Discover (Search Central documentation update of March 2, 2026, in [Search Central documentation updates](https://developers.google.com/search/updates)).

Each collection gets an optional `seo.schemaType` in its admin config: `BlogPosting` (default), `Article`, `NewsArticle` or `WebPage`. Setting `WebPage` drops the article node for collections such as landing pages.

#### Extending the graph

`PageMetadataContribution` gains one kind:

```ts
| {
		kind: "jsonld-node";
		/** Node key from the table above, or a new key for an added node. */
		id: string;
		/** Required for "replace" and "merge". */
		node?: Record<string, unknown>;
		mode: "replace" | "merge" | "remove";
  }
```

- `replace` swaps the core node for the given one. The `@id` stays the core value unless the contribution sets its own.
- `merge` shallow-merges the given properties into the core node. Arrays are replaced, not concatenated.
- `remove` drops the node. References to a removed node are removed from the remaining nodes.
- A new key adds a node. Plugins use this for `Service`, `Product`, `Event` or other types and reference core nodes by `@id`, for example `provider: { "@id": "https://example.com/#organization" }`. A `graphId(key)` helper returns the core `@id` for a node key so plugins don't hard-code the pattern.

Contributions apply in the existing order: the first contribution for a key wins, and site-level contributions come before plugin contributions. Nodes go through the same `safeJsonLdSerialize` as today.

The existing `{ kind: "jsonld", id: "primary" }` contribution keeps its meaning. A contribution with `id: "primary"` replaces the whole core graph, so themes that use the workaround from [issue #4471](https://github.com/emdash-cms/emdash/issues/4471) today keep their output. Other `jsonld` contributions are still emitted as separate script blocks.

Sandboxed plugins get the same contribution kind, through the `page:metadata` hook they already have.

#### Robots

`ContentSeo` gains `noFollow` next to `noIndex`, and site SEO settings gain `defaultRobots`:

```ts
interface SeoSettings {
	// existing fields unchanged
	defaultRobots?: {
		maxImagePreview?: "none" | "standard" | "large";
		maxSnippet?: number;
		maxVideoPreview?: number;
	};
}
```

The robots meta tag is assembled from the entry's `noIndex` and `noFollow` and the site defaults, using the rules from [Robots meta tag specifications](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag). New sites get `maxImagePreview: "large"`; existing sites get no new default until an administrator sets one. Staging sites keep emitting `noindex` for every page, as today.

The entry's `noFollow` is stored in a new `seo_no_follow` column on `_emdash_seo`. See [Compatibility and migration](#compatibility-and-migration) for existing `noIndex` values.

#### Author data in the page context

`createPublicPageContext` accepts `authors?: BylineSummary[]`. Templates pass `entry.data.bylines`, which `getEmDashEntry` already hydrates. When `authors` is absent, the article node falls back to `articleMeta.author` as a name-only `Person`, which is today's output. Core never queries bylines during a page render to build the graph.

### Phase 3: discovery

#### Sitemap providers

Phase 3 builds on design [#4341](https://github.com/emdash-cms/emdash/pull/4341), which adds a `sitemap.sitemaps` integration option for extra sitemaps that the site serves itself. This RFC adds a programmatic source next to that static list:

```ts
interface SitemapProvider {
	/** Becomes /sitemap-{id}.xml. Lowercase letters, digits and hyphens. */
	id: string;
	/** Index entries this provider contributes, with optional lastmod. */
	list(ctx: SitemapContext): Promise<Array<{ page: number; lastmod?: string }>>;
	/** Writes one page of the provider's sitemap. */
	render(ctx: SitemapContext, page: number): Promise<string>;
}
```

Native plugins register providers through a `sitemap:providers` hook. Core registers its own providers the same way. Provider IDs can't collide with collection slugs; a colliding provider is skipped with a warning in the log. Sandboxed plugins don't get providers in this RFC, because a provider renders a whole response.

Every provider follows Google's sitemap rules ([Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)):

- at most 50,000 URLs or 50 MB uncompressed per file; the writer helper pages automatically;
- only canonical URLs from `resolveEntryUrl`, and no entry whose canonical points elsewhere or that has `noindex`;
- `lastmod` reflects the last significant change of the page. Core uses the entry's `updated_at`, which changes on content, SEO and slug edits;
- no `priority` or `changefreq`, which Google ignores.

Core's collection sitemaps keep their current URLs and behavior.

#### News sitemap

A collection can enable a news sitemap in its admin config with a publication name. The provider serves `/sitemap-news.xml` with entries of all news-enabled collections, following [Create a news sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap):

- only entries published in the last two days;
- at most 1,000 `<news:news>` entries per file, split into several files beyond that;
- `<news:publication>` with `<news:name>` and `<news:language>`, derived from the entry locale as an ISO 639 code, with `zh-cn` and `zh-tw` for Chinese;
- `<news:publication_date>` from `published_at` with time zone, and `<news:title>` from the entry title.

Entries in news-enabled collections default to `NewsArticle` in the graph unless the collection sets another `schemaType`.

#### Video

Google requires a thumbnail, title and description for a video in a sitemap, and either the video file or a player URL ([Video sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/video-sitemaps)); `VideoObject` needs `name`, `thumbnailUrl` and `uploadDate` ([Video structured data](https://developers.google.com/search/docs/appearance/structured-data/video)). Entries don't carry these values today in a form core can rely on.

Phase 3 therefore ships only the format: a `VideoSource` interface that returns these properties for an entry, a `VideoObject` node builder, and a video sitemap provider that lists entries with at least one complete video. A video missing a required property is skipped and counted in the provider's log line. Embed plugins (YouTube, Vimeo) and media-library video support implement `VideoSource`. Core provides no source until media items can store a poster image.

#### IndexNow

IndexNow tells participating search engines about changed URLs ([IndexNow documentation](https://www.indexnow.org/documentation)). The protocol's [list of participating engines](https://www.indexnow.org/searchengines.json) includes Bing, Yandex, Naver, Seznam, Yep, Internet Archive and Amazonbot. Google is not on the list, so IndexNow has no effect on Google Search.

- **Key.** An administrator enables IndexNow in the SEO settings. Core then generates a key of 32 hexadecimal characters (the protocol allows 8 to 128) and stores it in `site:indexnow`, which is target-local: site transfer doesn't copy it, so a cloned site gets its own key.
- **Key file.** Core serves the key at `/indexnow-{key}.txt` as UTF-8 plain text and sends that URL as `keyLocation`. Because the file sits at the root of the host, it authorizes every URL on the host. Requests for any other key return 404.
- **Triggers.** Publishing (including scheduled publishing), publishing a new revision of a published entry, unpublishing, moving a published entry to trash, restoring a published entry, and slug changes of published entries submit the affected canonical URLs, including the old URL after a slug change. Saving a draft submits nothing. Core hooks into the same points that fire `content:afterPublish`, `content:afterUnpublish`, `content:afterDelete` and `content:afterRestore`.
- **Delivery.** Submissions run in `after()`, so they never delay the editor's request. Within one request, URLs are batched into one POST; the protocol allows up to 10,000 URLs per request. Core posts to `https://api.indexnow.org/indexnow`, which shares submissions with all participating engines.
- **Scope.** Core submits only URLs on the configured `site:url` host. Without `site:url`, or while the site is in staging, or when the host is `localhost` or a private address, IndexNow stays inactive and the settings screen says why.
- **Status.** Core stores the time and HTTP status of the last submission in `emdash:indexnow_status` and shows it in the SEO settings. A manual **Submit this URL** action in the editor's SEO panel submits the current entry.

### Phase 4: editorial tooling

Phase 4 is optional. Each item can ship on its own after Phase 2, and any of them can move to a plugin if Maintainers prefer.

- **Search and social preview.** The SEO panel shows how the entry's title, description and URL may appear in a search result, and how its Open Graph image, title and description look when shared. The preview uses the same resolved values as the head output, including fallbacks, and states that search engines choose their own snippets.
- **Robots controls.** The SEO panel shows **Hide from search results** (`noIndex`) and **Don't follow links** (`noFollow`) as separate switches. The SEO settings expose `defaultRobots`.
- **Redirect import and export.** CSV import and export for the existing redirects, with validation per row and a report of rejected rows ([issue #2291](https://github.com/emdash-cms/emdash/issues/2291)). The 404 log gains a **Create redirect** action.
- **Content checks.** Warnings in the SEO panel and in a site-wide report, each tied to a concrete fix: missing or duplicate SEO title, missing description, missing image alt text, an article image below the 50K pixels Google recommends, a canonical that points at a redirect or a 404, `noindex` on an entry linked from a menu, entries no other entry links to, and titles or descriptions beyond a configurable length. Checks never block a save, and plugins can add checks.
- **Key content.** Editors can mark an entry as key content. The report lists key entries not updated within a configurable period and key entries that few other entries link to.
- **Internal link suggestions.** Out of core. A plugin can read the draft through the trusted editor panel draft access and suggest links.

All new admin strings go through Lingui, layouts use logical Tailwind classes, and new screens are tested in Arabic.

## Compatibility and migration

### `site:social`

`site:social` stays readable and writable with its six keys.

- **Reading.** When `site:identity` is absent, `getSiteIdentity()` synthesizes it: type `Organization`, name from the site title, logo from `site:logo`, and one link per non-empty `site:social` key with `sameAs: true` and `relMe: false`. Today's output contains no `sameAs`, so a site that never opens the new settings starts emitting `sameAs` for its existing social links after Phase 2. The changeset says so.
- **Writing identity.** Saving `site:identity` also writes `site:social` in the same options batch. For each of the six keys, the first link of that platform becomes the value, converted back to a handle where the registry can extract one, and keys without a link are cleared. Themes that read `settings.social` keep showing the same profiles, including themes that build the profile URL from a stored handle.
- **Writing legacy.** A client that writes `site:social` updates the first link of each matching platform in `site:identity` and leaves every other link and switch untouched. An empty string removes that platform's first link.
- **Rollback.** An older version ignores `site:identity`. `site:social` still holds the current six values, because every write kept it in sync.

Site transfer exports `site:identity`. An older version that imports it ignores the unknown setting.

### Byline columns

A migration adds the nullable columns `profile_links` and `job_title` to `_emdash_bylines`. Each `ALTER TABLE` first checks whether the column exists, so the migration restarts cleanly after a partial run on D1. No backfill is needed, and old code ignores the columns during a rolling deploy.

### Robots

A migration adds `seo_no_follow` to `_emdash_seo` with default `0` and sets it to `1` where `seo_no_index` is `1`. Existing entries keep emitting `noindex, nofollow`; only new choices are split. The update is idempotent. Until the migration has run, code treats a missing column as `noFollow = noIndex`.

### JSON-LD output

Phase 2 changes the structured data of every page from one `BlogPosting` or `WebSite` object to one `@graph`. The existing `@id` values for the article and the organization stay the same.

- A `jsonld` contribution with `id: "primary"` still replaces all core structured data.
- `buildBlogPostingJsonLd` and `buildWebSiteJsonLd` stay exported with their current output. They are deprecated in favor of the graph builders, and the Maintainer who merges this RFC adds them to the [deprecations tracking issue](https://github.com/emdash-cms/emdash/issues/3917).
- Sites with snapshot tests of their pages will see changed markup. The changeset shows the old and new shapes.

### Canonical output

Pages whose template passes no `canonical` start emitting a self-referencing canonical in Phase 2. Without `site:url`, it uses the request origin, as `og:url` and the sitemap do today.

### Sitemaps

Collection sitemaps keep their URLs. Entries whose SEO canonical points at another URL leave the sitemap, which follows Google's guidance but lowers the URL count on those sites. The changeset says so.

## Security and privacy

- **Untrusted input.** Profile link values, identity fields and plugin graph nodes reach HTML only through `safeJsonLdSerialize` or attribute escaping. `rel="me"` and `sameAs` accept `https:` URLs only. `jsonld-node` contributions use the same serializer as `jsonld` contributions today.
- **Authorization.** Site identity and IndexNow settings require `settings:manage`. Byline profile links follow the existing byline permissions. A manual IndexNow submission requires permission to publish the entry.
- **Outbound requests.** IndexNow posts only to `api.indexnow.org`, and only canonical URLs on the configured site host, so editors can't make the server request arbitrary hosts. A failed submission logs the HTTP status, never the key.
- **Keys.** The IndexNow key is public by design, since the key file proves control of the host. It is excluded from site transfer so two sites don't share a key.
- **Privacy.** A personal site may publish an address, email or telephone number. Every identity field is optional and empty by default, and the admin labels the section as public. Staging sites send no IndexNow submissions, so search engines don't learn unreleased URLs from them.

## Performance

The logged-out render path keeps its query count:

- `site:identity` is a `site:*` option, so it arrives with the existing `getSiteSettings()` read and its isolate cache.
- Author nodes use `entry.data.bylines`, which entry hydration already loads, and the new byline columns are part of the row that query already selects.
- The graph is built in memory. Building and serializing it adds CPU time per render; the implementation measures it on a representative article page on Workers and reports the numbers in the Phase 2 PR.
- `pnpm query-counts` snapshots show no increase on logged-out routes in any phase.

Sitemaps run on their own routes. The news provider reads a two-day window. IndexNow runs after the response in `after()`.

## Failure handling

- **Invalid stored identity.** Values that fail validation on read, such as a link with an unsupported scheme written by an older client, are left out of the output and logged with the prefix `[seo]`. They stay in storage, and the admin shows them with an error so an administrator can fix them.
- **Graph builders.** A builder that throws is skipped and logged; the rest of the graph renders. A plugin contribution that fails to serialize is dropped, as `jsonld` contributions are today.
- **Sitemap providers.** A failing provider is left out of the index and logged, and its route returns 500. Other sitemaps are unaffected.
- **IndexNow.** 200 and 202 count as success. On 429 the URLs are kept and sent with the next submission. On 403 (key not valid) automatic submissions stop and the settings screen asks the administrator to check the key file. Other errors are logged and recorded in `emdash:indexnow_status`. No failure affects the save or publish that triggered it.
- **Missing site URL.** Graph and canonical output fall back to the request origin, and IndexNow stays inactive.

## Verification

- **Unit tests** for the platform registry, link validation, legacy synthesis, both directions of the `site:social` sync, each canonical rule, graph assembly per page type, `@id` stability, the three contribution modes and robots assembly.
- **Dialect tests** with `describeEachDialect` for both migrations, including a restart after the first completed statement and an upgrade from a database with existing `noIndex` entries.
- **Real D1 tests** in `tests/workerd` for the migrations and for the options batch that writes `site:identity` and `site:social` together.
- **Render tests** in `tests/repro` for an article, an author archive, a translation and page 2 of an archive. Each checks that canonical, `og:url`, sitemap `<loc>` and graph URLs agree for the same entry.
- **External validation.** The demo site's article, author and home pages checked with Google's Rich Results Test and the Schema.org validator, with results linked from the implementation PRs.
- **Query counts.** `pnpm query-counts` on SQLite and D1 shows no increase on logged-out routes.
- **IndexNow.** Tests with a stubbed `fetch` for batching, skipped hosts, staging, 403 and 429. One manual submission from the demo deployment, confirmed in Bing Webmaster Tools.
- **Admin.** Playwright tests for editing site identity and byline links, including the Arabic layout, and screenshots in every UI PR.

## Rollout and implementation

Kevin Kyburz (@swissky) and Evgenii Zinner (@Evgenii-Zinner) implement the phases. Each phase is one or more implementation PRs that link this RFC.

Phase 1 starts from Evgenii's prototype on the [`feat/dynamic-social-links`](https://github.com/Evgenii-Zinner/emdash/tree/feat/dynamic-social-links) branch of his fork. It already synthesizes the link list from `site:social` on read, converts stored handles to profile URLs with `relMe: false`, merges legacy writes without dropping custom links, and keeps `site:social` in sync on every write, with unit and render tests. The implementation PR keeps that engine, moves the list into `site:identity.links`, adds handle-only platforms and the separate `sameAs` switch, and moves `sameAs` from `WebSite` to the publisher node. The admin editor is rebuilt for the identity screen.

1. **Phase 1:** profile link types and platform registry, `site:identity` with legacy sync, byline columns, admin screens, `rel="me"`, `getSiteIdentity()`.
2. **Phase 2:** `resolveEntryUrl`, canonical rules, graph builders and `jsonld-node`, robots split, `authors` in the page context. The templates in `templates/` pass `authors` and pagination in the same PR.
3. **Phase 3:** sitemap providers on top of [#4341](https://github.com/emdash-cms/emdash/pull/4341), the news sitemap, the video format and IndexNow. IndexNow can ship before the sitemap work.
4. **Phase 4:** each tool separately, in any order.

Phase 2 can begin before Phase 1's admin screens are finished, because it reads synthesized identity when none is stored. No feature flag is needed: Phase 1 adds data without changing output until Phase 2, and Phase 2's output changes are covered by the compatibility rules above. The deprecated builders are removed in the next major release.

## Alternatives

- **Feature plan for social links only.** Design [#4714](https://github.com/emdash-cms/emdash/pull/4714) fixes the closed list, but the links feed `sameAs`, which belongs to the publisher and author model. Designing them apart would fix one data shape now and change it again for authors and the graph. Its author co-authors this RFC, and #4714 is superseded by Phase 1.
- **Separate RFCs per area.** Identity, graph, canonical URLs and discovery share `resolveEntryUrl` and the `@id` scheme. Separate RFCs would each have to restate and agree on those. One RFC with independently shippable phases keeps a single contract.
- **Everything in a plugin.** A plugin can't change the closed settings schema, the byline table, canonical defaults or the sitemap index. Core keeps the shared data and output; plugins extend it through `jsonld-node`, sitemap providers and content checks.
- **Custom byline fields for profile links.** They would work without a migration, but group-shared custom fields need the hydration queries on every render that shows bylines, and each site would define the field differently.
- **`sameAs` on `WebSite`.** Schema.org allows it on any `Thing`, but Google documents profile links on `Organization` and on authors, so the RFC puts them on the publisher and author nodes.
- **Separate script blocks per type.** This is how core works today. Unconnected blocks repeat the publisher and author and can't express that the article belongs to the page and the page to the site.

## Drawbacks

- Phase 2 changes structured data and canonical output on every existing site, which can move search appearance for better or worse during recrawling.
- Keeping `site:social` and `site:identity` in sync adds write logic that stays until a major release removes `site:social`.
- Sites gain more settings. The admin keeps rarely used fields (policies, identifiers, address) collapsed.
- The video format ships without a core data source, so it does nothing until an embed plugin or media support implements `VideoSource`.
- IndexNow sends data to a third-party service; it is off by default and enabled per site.

## Open questions

1. Should synthesized identity emit `sameAs` for legacy `site:social` values by default, or only after an administrator saves the new settings once?
2. Should `profile_links` be per locale, as proposed, or shared across a byline's translations?
3. Does `seo.schemaType` belong in collection admin config, or in the collection's `supports` list?
4. Should IndexNow ship in core, or as a first-party plugin that uses the same publish hooks?
5. Who is the sponsoring Maintainer?

Before the design PR opens, the champion agrees co-authorship with the contributors whose designs this RFC builds on. The author of #4714 has joined as co-author; the author of #4341 has been asked.
