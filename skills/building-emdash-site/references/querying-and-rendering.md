# Querying and Rendering Content

## Content Queries

All query functions are imported from `"emdash"`.

### getEmDashCollection

Fetch multiple entries from a collection. Returns `{ entries, error, cacheHint, nextCursor }`.

```typescript
import { getEmDashCollection } from "emdash";

// Basic
const { entries: posts } = await getEmDashCollection("posts");

// With options
const { entries: posts, cacheHint } = await getEmDashCollection("posts", {
	status: "published",
	limit: 10,
	orderBy: { published_at: "desc" },
	where: { category: "news" },
});
```

Options:

- `status` -- filter by status (`"published"`, `"draft"`, etc.)
- `limit` -- max entries
- `cursor` -- opaque cursor for keyset pagination (pass `nextCursor` from a previous result)
- `orderBy` -- `{ field: "asc" | "desc" }` (default: `{ created_at: "desc" }`)
- `where` -- filter by field values or taxonomy terms. Supports arrays for OR: `{ category: ["news", "featured"] }`
- `locale` -- filter by locale (when i18n is configured)

### getEmDashEntry

Fetch a single entry by slug. Returns `{ entry, error, isPreview, cacheHint }`.

```typescript
import { getEmDashEntry } from "emdash";

const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);

if (!post) {
	return Astro.redirect("/404");
}
```

### Entry Shape

```typescript
interface ContentEntry<T> {
	id: string; // The slug (used in URLs)
	data: T; // All fields, including system fields
	edit: EditProxy; // Visual editing attributes (spread onto elements)
}

// data includes system fields plus your custom fields:
interface PostData {
	id: string; // Database ULID (use for taxonomy lookups, etc.)
	slug: string;
	status: string;
	title: string;
	featured_image?: {
		id: string;
		src?: string;
		alt?: string;
		width?: number;
		height?: number;
	};
	content?: PortableTextBlock[];
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	// Bylines (eagerly loaded)
	byline: BylineSummary | null; // Primary author
	bylines: ContentBylineCredit[]; // All credits (with roleLabel, source)
	// ... your custom fields
}
```

**Important:** `entry.id` is the slug (for URLs), `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).

### Reference Fields

A `reference` field's value is not in `data`. Ask for it by field slug through the `references` option, and read the page it returns:

```typescript
const { entry: post } = await getEmDashEntry("posts", slug, {
	references: { author: true, related_posts: { limit: 6 } },
});

const author = post?.references?.author.entries[0];
const related = post?.references?.related_posts.entries ?? [];
```

`true` is the first page at the default limit of 50; `{ limit, cursor }` takes at most 100 per page. `getEmDashReferences(collection, id, field, { cursor, limit })` fetches the next page of one field on its own.

Each referenced entry is a full `ContentEntry` -- same `data` mapping, and an `edit` proxy scoped to the referenced entry. Bylines and taxonomy terms are **not** hydrated onto referenced entries; read those from the entry itself.

Entries come back in the editor's order when the field sits on the parent end of its relation. A field on the child end lists whatever points at it, unordered.

Ask only for the fields the page renders: a call with no `references` runs no extra queries, and each selected field costs one link query plus one entry query per distinct target collection.

A public render sees published entries and the published selection. Preview and visual editing see the selection staged in the entry's draft.

Generated types register a `{Collection}References` interface per collection with bound reference fields, so `post.references.author.entries[0].data` carries the target collection's interface and a field that was not selected is a type error.

### Caching

Query results include a `cacheHint` for Astro's Route Caching:

```astro
---
const { entries: posts, cacheHint } = await getEmDashCollection("posts");
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
```

When Astro's route cache is enabled, call `Astro.cache.set(cacheHint)` so publishing invalidates cached output.

## Rendering Portable Text

### PortableText component

```astro
---
import { PortableText } from "emdash/ui";
---
<PortableText value={post.data.content} />
```

Renders standard blocks (paragraphs, headings, lists, blockquotes, code blocks, images) and inline marks (bold, italic, code, strikethrough, links).

### Custom block types

For custom Portable Text objects that belong inside a rich-text document, pass a `components` prop:

```astro
---
import { PortableText } from "emdash/ui";
import Diagram from "./blocks/Diagram.astro";

const customTypes = {
	"publication.diagram": Diagram,
};
---
<PortableText value={page.data.content} components={{ type: customTypes }} />
```

Each custom component receives the block data as props.

## Rendering a blocks field

Use `Blocks` for an ordered composition stored in a `blocks` collection field. Map each generated `_type` to an Astro component at the call site.

```astro
---
import { Blocks, defineBlockComponents } from "emdash/ui";
import type { PageLayoutBlock } from "../../emdash-env";
import Hero from "../components/blocks/Hero.astro";
import FeatureGrid from "../components/blocks/FeatureGrid.astro";

const components = defineBlockComponents<PageLayoutBlock>({
	hero: Hero,
	feature_grid: FeatureGrid,
});
---

<Blocks value={page.data.layout} components={components} />
```

Each component receives `{ value, index, blockKey }`. The value retains `_version`, so a renderer can narrow old and active shapes. `Blocks` performs no database or network queries.

An unmapped type produces a visible development placeholder. In production it renders the optional `fallback` component or no output. Ship renderer support before activating a new breaking block version.

## Image Component

**Always use the EmDash Image component for CMS images.** Image fields are objects, not strings.

```astro
---
import { Image } from "emdash/ui";
---

{/* Correct -- passes the image object */}
<Image image={post.data.featured_image} />

{/* Also works with explicit props */}
{post.data.featured_image?.src && (
	<img src={post.data.featured_image.src} alt={post.data.featured_image.alt || ""} />
)}
```

**Common mistake:**

```astro
{/* WRONG -- image is an object, not a string */}
<img src={post.data.featured_image} />
```

## Visual Editing Attributes

Entries include `edit` attributes for inline editing. Spread them onto the element that displays the field:

```astro
<h1 {...post.edit.title}>{post.data.title}</h1>
<p {...post.edit.excerpt}>{post.data.excerpt}</p>
<div {...post.edit.featured_image}>
	<Image image={post.data.featured_image} />
</div>
```

When an admin is logged in and views the site, these attributes enable click-to-edit functionality.

## Common Page Patterns

### List page (e.g., `/posts/index.astro`)

```astro
---
import { getEmDashCollection } from "emdash";
import { Image } from "emdash/ui";
import Base from "../../layouts/Base.astro";

const { entries: posts, cacheHint } = await getEmDashCollection("posts", {
	orderBy: { published_at: "desc" },
	limit: 20,
});
if (Astro.cache?.enabled) Astro.cache.set(cacheHint);
---
<Base title="Posts">
		{posts.map(post => (
		<article>
			{post.data.featured_image && <Image image={post.data.featured_image} />}
			<a href={`/posts/${post.id}`}>{post.data.title}</a>
			{post.data.excerpt && <p>{post.data.excerpt}</p>}
		</article>
	))}
</Base>
```

### Detail page (e.g., `/posts/[slug].astro`)

```astro
---
import { getEmDashEntry, getSeoMeta } from "emdash";
import { Image, PortableText } from "emdash/ui";
import Base from "../../layouts/Base.astro";

const { slug } = Astro.params;
if (!slug) return Astro.redirect("/404");

const { entry: post, cacheHint } = await getEmDashEntry("posts", slug);
if (!post) return Astro.redirect("/404");

if (Astro.cache?.enabled) Astro.cache.set(cacheHint);

const seo = getSeoMeta(post, {
	siteTitle: "My Blog",
	siteUrl: Astro.url.origin,
	path: `/posts/${slug}`,
});

const tags = post.data.terms?.tag ?? [];
---
<Base title={seo.title} description={seo.description}>
	<article>
		{post.data.featured_image && (
			<div {...post.edit.featured_image}>
				<Image image={post.data.featured_image} />
			</div>
		)}
		<h1 {...post.edit.title}>{post.data.title}</h1>
		<PortableText value={post.data.content} />
		{tags.length > 0 && (
			<div>
				{tags.map(t => <a href={`/tag/${t.slug}`}>{t.label}</a>)}
			</div>
		)}
	</article>
</Base>
```

### Taxonomy archive (e.g., `/category/[slug].astro`)

```astro
---
import { getTaxonomyTermsWithCacheHint, getEmDashCollection } from "emdash";
import Base from "../../layouts/Base.astro";

const { slug } = Astro.params;
const termsResult = await getTaxonomyTermsWithCacheHint("category", { includeCounts: false });
const term = slug ? termsResult.data.find((item) => item.slug === slug) : null;
if (!term) return Astro.redirect("/404");

const { entries: posts, cacheHint } = await getEmDashCollection("posts", {
	where: { category: term.slug },
	orderBy: { published_at: "desc" },
	limit: 20,
});
if (Astro.cache?.enabled) {
	Astro.cache.set(termsResult.cacheHint);
	Astro.cache.set(cacheHint);
}
---
<Base title={`${term.label} posts`}>
	<h1>{term.label}</h1>
	{posts.map(post => (
		<a href={`/posts/${post.id}`}>{post.data.title}</a>
	))}
</Base>
```

### RSS feed (e.g., `/rss.xml.ts`)

```typescript
import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";

const siteTitle = "My Site";

export const GET: APIRoute = async ({ url }) => {
	const siteUrl = url.origin;
	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 20,
	});

	const items = posts
		.filter((p) => p.data.publishedAt)
		.map((post) => {
			const postUrl = `${siteUrl}/posts/${post.id}`;
			return `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <pubDate>${post.data.publishedAt!.toUTCString()}</pubDate>
      <description>${escapeXml(post.data.excerpt || "")}</description>
    </item>`;
		})
		.join("\n");

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteTitle)}</title>
    <link>${siteUrl}</link>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`,
		{
			headers: {
				"Content-Type": "application/rss+xml; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		},
	);
};

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
```

### 404 page (`/404.astro`)

```astro
---
import Base from "../layouts/Base.astro";
---
<Base title="Not Found">
	<h1>Page not found</h1>
	<p>The page you're looking for doesn't exist.</p>
	<a href="/">Go home</a>
</Base>
```

### Empty state

When a collection has no content, show a helpful empty state:

```astro
{posts.length === 0 ? (
	<section>
		<h2>No posts yet</h2>
		<p>Create your first post in the admin panel.</p>
		<a href="/_emdash/admin/content/posts/new">Create a post</a>
	</section>
) : (
	/* ... render posts ... */
)}
```

## Pagination

`getEmDashCollection` supports cursor-based keyset pagination. Pass `cursor` from a previous result's `nextCursor` to get the next page:

```astro
---
const cursor = Astro.url.searchParams.get("cursor") ?? undefined;
const { entries, nextCursor, cacheHint } = await getEmDashCollection("posts", {
	limit: 10,
	cursor,
	orderBy: { published_at: "desc" },
});
Astro.cache.set(cacheHint);
---
{entries.map(post => (
	<a href={`/posts/${post.id}`}>{post.data.title}</a>
))}
{nextCursor && <a href={`?cursor=${nextCursor}`}>Next page</a>}
```

`nextCursor` is `undefined` when there are no more results.

## Date Formatting

Dates come as `Date` objects. Use `toLocaleDateString` or `Intl.DateTimeFormat`:

```typescript
const formatted = post.data.publishedAt?.toLocaleDateString("en-US", {
	year: "numeric",
	month: "long",
	day: "numeric",
});
```
