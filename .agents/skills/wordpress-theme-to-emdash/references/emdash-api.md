# EmDash API Reference

Quick reference for EmDash-specific APIs used when porting themes.

> **See also:** The `scaffold/` directory contains working examples of all these patterns. When in doubt, copy from there.

## Content Retrieval

EmDash's query functions follow Astro's [live content collections](https://docs.astro.build/en/reference/experimental-flags/live-content-collections/) pattern, returning structured results for graceful error handling.

### getEmDashCollection

Fetch multiple entries from a collection.

```typescript
import { getEmDashCollection } from "emdash";

// Returns { entries, error }
const { entries: posts } = await getEmDashCollection("posts");

// With filters
const { entries: posts } = await getEmDashCollection("posts", {
	status: "published",
	limit: 10,
	where: { category: "news" },
});
```

### getEmDashEntry

Fetch a single entry by slug.

```typescript
import { getEmDashEntry } from "emdash";

// Returns { entry, error, isPreview }
const { entry: post } = await getEmDashEntry("posts", "hello-world");

if (!post) {
	return Astro.redirect("/404");
}
```

### Entry Shape

```typescript
interface Entry {
	id: string;
	collection: string;
	data: {
		title: string;
		slug: string;
		content: PortableTextBlock[];
		featured_image?: ImageField; // { src, alt } - NOT a string!
		// ... custom fields
	};
}
```

## Field Types at Runtime

**IMPORTANT:** Field types have specific runtime shapes. The most common mistake is treating image fields as strings.

### Image Fields

Image fields are **objects**, not strings:

```typescript
interface ImageField {
	src: string; // The resolved URL
	alt?: string;
}
```

```astro
{/* CORRECT */}
{post.data.featured_image?.src && (
  <img
    src={post.data.featured_image.src}
    alt={post.data.featured_image.alt || post.data.title}
  />
)}

{/* WRONG - renders [object Object] */}
<img src={post.data.featured_image} />
```

### Reference Fields

In seed files use `"$ref:id"` format. At runtime they may be resolved objects or strings.

### PortableText Fields

Rich content is an array of blocks with `_type` property.

## Site Settings

### getSiteSettings

Get all site settings.

```typescript
import { getSiteSettings } from "emdash";

const settings = await getSiteSettings();
console.log(settings.title); // "My Site"
console.log(settings.logo?.url); // Resolved media URL
```

### getSiteSetting

Get a single setting.

```typescript
import { getSiteSetting } from "emdash";

const title = await getSiteSetting("title");
const logo = await getSiteSetting("logo");
```

### Available Settings

| Key          | Type             | Description              |
| ------------ | ---------------- | ------------------------ |
| `title`      | `string`         | Site name                |
| `tagline`    | `string`         | Site tagline/description |
| `logo`       | `MediaReference` | Site logo with URL       |
| `favicon`    | `MediaReference` | Favicon with URL         |
| `social`     | `SocialLinks`    | Social media URLs        |
| `timezone`   | `string`         | Site timezone            |
| `dateFormat` | `string`         | Date display format      |

## Navigation Menus

### getMenu

Fetch a menu by name with resolved URLs.

```typescript
import { getMenu } from "emdash";

const menu = await getMenu("primary");

if (menu) {
	console.log(menu.items); // MenuItem[]
}
```

### getMenus

Get all menus (names only).

```typescript
import { getMenus } from "emdash";

const menus = await getMenus();
// [{ id, name, label }]
```

### MenuItem Shape

```typescript
interface MenuItem {
	id: string;
	label: string;
	url: string; // Resolved URL
	target?: string;
	children: MenuItem[];
}
```

### Rendering Menus

```astro
---
import { getMenu } from "emdash";

const primaryMenu = await getMenu("primary");
---
<nav>
  {primaryMenu?.items.map(item => (
    <a href={item.url}>{item.label}</a>
  ))}
</nav>
```

## Taxonomies

### getTaxonomyTerms

Get all terms for a taxonomy.

```typescript
import { getTaxonomyTerms } from "emdash";

const categories = await getTaxonomyTerms("categories");
const tags = await getTaxonomyTerms("tags");
```

### getTerm

Get a single term by slug.

```typescript
import { getTerm } from "emdash";

const term = await getTerm("categories", "news");
console.log(term?.label); // "News"
console.log(term?.count); // Number of entries
```

### getEntryTerms

Get terms assigned to a specific entry.

> **IMPORTANT:** This function does NOT take a `db` parameter.

```typescript
import { getEntryTerms } from "emdash";

// Get all terms for an entry
const terms = await getEntryTerms("posts", post.id);

// Get only categories
const categories = await getEntryTerms("posts", post.id, "categories");
```

### getEntriesByTerm

Get entries that have a specific term.

```typescript
import { getEntriesByTerm } from "emdash";

const posts = await getEntriesByTerm("posts", "categories", "news");
```

### TaxonomyTerm Shape

```typescript
interface TaxonomyTerm {
	id: string;
	name: string; // Taxonomy name
	slug: string; // Term slug
	label: string; // Display label
	children: TaxonomyTerm[];
	count?: number;
}
```

## Widget Areas

### getWidgetArea

Get a widget area by name.

```typescript
import { getWidgetArea } from "emdash";

const sidebar = await getWidgetArea("sidebar");

if (sidebar) {
	console.log(sidebar.widgets); // Widget[]
}
```

### Widget Types

| Type        | Description          | Key Fields             |
| ----------- | -------------------- | ---------------------- |
| `content`   | Rich text (PT)       | `content`              |
| `menu`      | Navigation menu      | `menuName`             |
| `component` | Registered component | `componentId`, `props` |

## Sections (Reusable Blocks)

Sections are reusable content blocks that editors can insert via `/section` slash command.

### getSection

Get a single section by slug.

```typescript
import { getSection } from "emdash";

const cta = await getSection("newsletter-cta");
// Returns { id, slug, title, content, keywords, source }
```

### getSections

List sections with optional filters.

```typescript
import { getSections } from "emdash";

// Get all sections
const all = await getSections();

// Filter by source: "theme" | "user" | "import"
const imported = await getSections({ source: "import" });
```

### Section Sources

| Source   | Description                             |
| -------- | --------------------------------------- |
| `theme`  | Defined in seed file                    |
| `user`   | Created by editors in admin             |
| `import` | Imported from WordPress reusable blocks |

## Search

### search

Global search across collections.

```typescript
import { search } from "emdash";

const results = await search("hello world", {
	collections: ["posts", "pages"], // Optional: limit to specific collections
	status: "published", // Optional: filter by status
	limit: 20, // Optional: max results
});

// Returns { results: SearchResult[], total, nextCursor? }
results.results.forEach((r) => {
	console.log(r.collection); // "posts"
	console.log(r.id); // Entry ID
	console.log(r.title); // Entry title
	console.log(r.slug); // Entry slug
	console.log(r.snippet); // HTML snippet with <mark> highlights
	console.log(r.score); // Relevance score
});
```

### LiveSearch Component

Ready-to-use search with instant results:

```astro
---
import LiveSearch from "emdash/ui/search";
---

<LiveSearch
  placeholder="Search..."
  collections={["posts", "pages"]}
/>
```

Features:

- Debounced instant search
- Prefix matching (automatic `*` suffix)
- Porter stemming ("run" finds "running")
- Result snippets with `<mark>` highlights

### Search Configuration

Search is enabled per-collection via admin UI:

1. Edit Content Type → check "Search" in Features
2. Edit fields → check "Searchable" for text fields

Only collections with search enabled are indexed.

## Rendering Content

### PortableText Component

```astro
---
import { PortableText } from "emdash/ui";
---

<PortableText value={post.data.content} />
```

## CLI Commands

### Seed Validation

Validate seed files before applying:

```bash
# Validate default seed file (.emdash/seed.json)
emdash seed --validate

# Validate a specific file
emdash seed path/to/seed.json --validate
```

Catches common mistakes:

- Image fields with raw URLs (should use `$media`)
- Reference fields with raw IDs (should use `$ref:id`)
- PortableText not an array or missing `_type`
- Type mismatches (string vs number, etc.)

### Apply Seed

```bash
# Apply seed with content
emdash seed

# Apply seed without sample content
emdash seed --no-content

# Specify database path
emdash seed --database ./my-data.db
```

### Export Seed

```bash
# Export schema only
emdash export-seed

# Export schema and all content
emdash export-seed --with-content

# Export specific collections
emdash export-seed --with-content=posts,pages
```

## Configuration

### astro.config.mjs

```javascript
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	integrations: [
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
});
```

### live.config.ts

```typescript
// src/live.config.ts
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
```

## Common Patterns

### Homepage with Recent Posts

```astro
---
import { getEmDashCollection, getSiteSettings } from "emdash";
import Base from "../layouts/Base.astro";

const settings = await getSiteSettings();
const { entries: posts } = await getEmDashCollection("posts", { limit: 10 });
---
<Base title={settings.title}>
  {posts.map(post => (
    <article>
      <a href={`/posts/${post.data.slug}`}>{post.data.title}</a>
    </article>
  ))}
</Base>
```

### Category Archive

```astro
---
import { getTerm, getEntriesByTerm } from "emdash";

const { slug } = Astro.params;
const category = await getTerm("categories", slug);
const posts = await getEntriesByTerm("posts", "categories", slug);
---
<h1>{category?.label}</h1>
{posts.map(post => (
  <a href={`/posts/${post.data.slug}`}>{post.data.title}</a>
))}
```

### Dynamic Navigation

```astro
---
import { getMenu, getSiteSettings } from "emdash";

const settings = await getSiteSettings();
const primaryMenu = await getMenu("primary");
---
<header>
  <a href="/">{settings.title}</a>
  <nav>
    {primaryMenu?.items.map(item => (
      <a href={item.url}>{item.label}</a>
    ))}
  </nav>
</header>
```
