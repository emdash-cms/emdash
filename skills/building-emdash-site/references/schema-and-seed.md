# Schema and Seed Files

The seed file (`seed/seed.json`) defines the site's entire schema and optional demo content. It's inlined into the build and applied automatically on the first request when the database is empty and the setup wizard hasn't been completed.

## Seed File Structure

```json
{
	"$schema": "https://emdashcms.com/seed.schema.json",
	"version": "1",
	"meta": {
		"name": "My Site",
		"description": "A description of this site",
		"author": "Author Name"
	},
	"settings": { ... },
	"collections": [ ... ],
	"taxonomies": [ ... ],
	"menus": [ ... ],
	"widgetAreas": [ ... ],
	"sections": [ ... ],
	"bylines": [ ... ],
	"content": { ... }
}
```

## Collections

Collections define content types. Each collection becomes a database table (`ec_{slug}`).

```json
{
	"slug": "posts",
	"label": "Posts",
	"labelSingular": "Post",
	"supports": ["drafts", "revisions", "search", "seo"],
	"commentsEnabled": true,
	"fields": [ ... ]
}
```

### Collection Supports

| Support     | Description               |
| ----------- | ------------------------- |
| `drafts`    | Draft/published workflow  |
| `revisions` | Revision history          |
| `search`    | Full-text search indexing |
| `seo`       | SEO meta fields in admin  |

### Slug Rules

- Lowercase alphanumeric + underscores: `/^[a-z][a-z0-9_]*$/`
- Max 63 characters
- Cannot conflict with reserved slugs

## Field Types

| Type           | Column type | Runtime shape                         | Notes                        |
| -------------- | ----------- | ------------------------------------- | ---------------------------- |
| `string`       | TEXT        | `string`                              | Single line text             |
| `text`         | TEXT        | `string`                              | Multi-line text (textarea)   |
| `number`       | REAL        | `number`                              | Floating point               |
| `integer`      | INTEGER     | `number`                              | Whole numbers                |
| `boolean`      | INTEGER     | `boolean`                             | Stored as 0/1                |
| `datetime`     | TEXT        | `Date`                                | ISO 8601 string in DB        |
| `image`        | TEXT        | `{ id, src?, alt?, width?, height? }` | **Object, not a string**     |
| `reference`    | TEXT        | `string` (ID)                         | Reference to another entry   |
| `portableText` | JSON        | `PortableTextBlock[]`                 | Rich text as structured JSON |
| `json`         | JSON        | `any`                                 | Arbitrary JSON data          |

### Field Definition

```json
{
	"slug": "title",
	"label": "Title",
	"type": "string",
	"required": true,
	"searchable": true
}
```

Fields can have:

- `slug` (required) -- field identifier
- `label` (required) -- display label in admin
- `type` (required) -- one of the types above
- `required` -- validation
- `searchable` -- include in full-text search index

### Common Field Patterns

**Blog post:**

```json
"fields": [
	{ "slug": "title", "label": "Title", "type": "string", "required": true, "searchable": true },
	{ "slug": "featured_image", "label": "Featured Image", "type": "image" },
	{ "slug": "content", "label": "Content", "type": "portableText", "searchable": true },
	{ "slug": "excerpt", "label": "Excerpt", "type": "text" }
]
```

**Portfolio project:**

```json
"fields": [
	{ "slug": "title", "label": "Title", "type": "string", "required": true, "searchable": true },
	{ "slug": "featured_image", "label": "Featured Image", "type": "image", "required": true },
	{ "slug": "client", "label": "Client", "type": "string" },
	{ "slug": "year", "label": "Year", "type": "string" },
	{ "slug": "summary", "label": "Summary", "type": "text", "searchable": true },
	{ "slug": "content", "label": "Content", "type": "portableText", "searchable": true },
	{ "slug": "gallery", "label": "Gallery", "type": "json" },
	{ "slug": "url", "label": "Project URL", "type": "string" }
]
```

**Page (minimal):**

```json
"fields": [
	{ "slug": "title", "label": "Title", "type": "string", "required": true, "searchable": true },
	{ "slug": "content", "label": "Content", "type": "portableText", "searchable": true }
]
```

## Taxonomies

Taxonomies are tag/category systems attached to collections.

```json
{
	"name": "category",
	"label": "Categories",
	"labelSingular": "Category",
	"hierarchical": true,
	"collections": ["posts"],
	"terms": [
		{ "slug": "development", "label": "Development" },
		{ "slug": "design", "label": "Design" }
	]
}
```

- `hierarchical: true` -- tree structure (like WordPress categories)
- `hierarchical: false` -- flat list (like WordPress tags)
- `collections` -- which collections this taxonomy applies to
- `terms` -- pre-defined terms to create

## Menus

Navigation menus, managed from the admin UI.

```json
{
	"name": "primary",
	"label": "Primary Navigation",
	"items": [
		{ "type": "custom", "label": "Home", "url": "/" },
		{ "type": "custom", "label": "About", "url": "/pages/about" },
		{ "type": "custom", "label": "Posts", "url": "/posts" }
	]
}
```

Menu item types:

- `custom` -- arbitrary URL
- Content references are resolved at render time

## Widget Areas

Named regions where editors can add configurable widgets.

```json
{
	"name": "sidebar",
	"label": "Sidebar",
	"description": "Widget area displayed on single post pages",
	"widgets": [
		{
			"type": "component",
			"componentId": "core:search",
			"title": "Search"
		},
		{
			"type": "component",
			"componentId": "core:categories",
			"title": "Categories"
		},
		{
			"type": "component",
			"componentId": "core:tags",
			"title": "Tags"
		},
		{
			"type": "component",
			"componentId": "core:recent-posts",
			"title": "Recent Posts",
			"settings": { "count": 5, "showDate": true }
		},
		{
			"type": "component",
			"componentId": "core:archives",
			"title": "Archives",
			"settings": { "type": "monthly", "limit": 6 }
		},
		{
			"type": "content",
			"title": "About",
			"content": [
				{
					"_type": "block",
					"style": "normal",
					"children": [{ "_type": "span", "text": "Some rich text content." }]
				}
			]
		}
	]
}
```

### Widget types

| Type        | Description               | Key fields                |
| ----------- | ------------------------- | ------------------------- |
| `content`   | Rich text (Portable Text) | `content`                 |
| `menu`      | Navigation menu           | `menuName`                |
| `component` | Core or custom component  | `componentId`, `settings` |

### Core widget components

- `core:search` -- search form
- `core:categories` -- category list with counts
- `core:tags` -- tag cloud
- `core:recent-posts` -- latest posts list
- `core:archives` -- monthly archive links

## Sections (Reusable Blocks)

Reusable content blocks that editors can insert via `/section` slash command in the editor.

```json
{
	"slug": "newsletter-signup",
	"title": "Newsletter Signup",
	"description": "A call-to-action block for newsletter subscriptions",
	"keywords": ["newsletter", "subscribe", "email", "cta"],
	"source": "theme",
	"content": [
		{
			"_type": "block",
			"style": "h3",
			"children": [{ "_type": "span", "text": "Stay in the loop" }]
		},
		{
			"_type": "block",
			"style": "normal",
			"children": [{ "_type": "span", "text": "Get notified when new posts are published." }]
		}
	]
}
```

## Bylines

Named author profiles, independent of user accounts.

```json
{
	"id": "byline-editorial",
	"slug": "emdash-editorial",
	"displayName": "EmDash Editorial"
}
```

Guest bylines:

```json
{
	"id": "byline-guest",
	"slug": "guest-contributor",
	"displayName": "Guest Contributor",
	"isGuest": true
}
```

## Settings

Site-wide settings:

```json
"settings": {
	"title": "My Blog",
	"tagline": "Thoughts on building for the web"
}
```

Available keys: `title`, `tagline`, `logo`, `favicon`, `social`, `timezone`, `dateFormat`.

## Content

Sample content organized by collection slug:

```json
"content": {
	"posts": [
		{
			"id": "post-1",
			"slug": "hello-world",
			"status": "published",
			"data": {
				"title": "Hello World",
				"excerpt": "My first post.",
				"featured_image": {
					"$media": {
						"url": "https://images.unsplash.com/photo-xxx?w=1200&h=800&fit=crop",
						"alt": "Description of image",
						"filename": "hello-world.jpg"
					}
				},
				"content": [
					{
						"_type": "block",
						"style": "normal",
						"children": [{ "_type": "span", "text": "This is the body text." }]
					}
				]
			},
			"bylines": [
				{ "byline": "byline-editorial" }
			],
			"taxonomies": {
				"category": ["development"],
				"tag": ["webdev", "opinion"]
			}
		}
	],
	"pages": [
		{
			"id": "about",
			"slug": "about",
			"status": "published",
			"data": {
				"title": "About",
				"content": [
					{
						"_type": "block",
						"style": "normal",
						"children": [{ "_type": "span", "text": "About this site." }]
					}
				]
			}
		}
	]
}
```

### Media references in seed content

Use `$media` for image fields -- EmDash downloads and stores the image:

```json
"featured_image": {
	"$media": {
		"url": "https://images.unsplash.com/photo-xxx?w=1200&h=800&fit=crop",
		"alt": "Description",
		"filename": "my-image.jpg"
	}
}
```

For external images without downloading:

```json
"featured_image": "https://images.unsplash.com/photo-xxx?w=1200"
```

### Reference fields in seed content

Use `$ref:id` format to reference other entries:

```json
"author": "$ref:byline-editorial"
```

### Portable Text in seed content

Content fields of type `portableText` are arrays of blocks:

```json
[
	{
		"_type": "block",
		"style": "normal",
		"children": [{ "_type": "span", "text": "A paragraph." }]
	},
	{
		"_type": "block",
		"style": "h2",
		"children": [{ "_type": "span", "text": "A heading" }]
	},
	{
		"_type": "block",
		"style": "blockquote",
		"children": [{ "_type": "span", "text": "A quote." }]
	}
]
```

Inline marks (bold, italic, links):

```json
{
	"_type": "block",
	"style": "normal",
	"children": [
		{ "_type": "span", "text": "This is " },
		{ "_type": "span", "text": "bold", "marks": ["strong"] },
		{ "_type": "span", "text": " and " },
		{ "_type": "span", "text": "italic", "marks": ["em"] }
	]
}
```

Block styles: `normal`, `h1`-`h6`, `blockquote`.

### Draft content

Set `"status": "draft"` to create unpublished content:

```json
{
	"id": "post-draft",
	"slug": "work-in-progress",
	"status": "draft",
	"data": { ... }
}
```

## Applying Seeds

The seed at `.emdash/seed.json`, `package.json#emdash.seed`, or `seed/seed.json` is inlined into the build and applied on the first request when the database is empty and the setup wizard hasn't been completed. Existing data is never overwritten.

Validation runs at apply time. Common errors caught:

- Image fields with raw URLs (should use `$media`)
- Reference fields with raw IDs (should use `$ref:id`)
- PortableText not an array or missing `_type`
- Type mismatches (string vs number, etc.)

If the seed is invalid, the first request fails and the error is logged. Restart the dev server after fixing it.

## Exporting Seeds

```bash
npx emdash export-seed                      # Schema only
npx emdash export-seed --with-content       # Schema + all content
npx emdash export-seed --with-content=posts,pages  # Specific collections
```
