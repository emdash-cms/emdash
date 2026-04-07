# Phase 5: Create Seed File

Combine all theme features into a seed file with sample content.

## 5.1 Image Strategy

**Use the same images you downloaded in Phase 1** for visual consistency.

1. **Open source themes (GPL)**: Use exact images from the demo
2. **Premium themes**: Use Unsplash images matching the demo's style
3. **Local images**: Reference with `file:./` prefix:
   ```json
   "featured_image": {
     "$media": {
       "url": "file:./discovery/images/hero.jpg",
       "alt": "Hero image"
     }
   }
   ```

## 5.2 Validate Before Applying

```bash
# Validate without applying
emdash seed --validate
```

The validator catches common mistakes:

| Check                        | Error                     |
| ---------------------------- | ------------------------- |
| Image using raw URL          | "must use $media syntax"  |
| Reference using raw ID       | "must use $ref:id syntax" |
| PortableText not an array    | "expected array"          |
| PortableText missing `_type` | "missing required \_type" |

### Common Fixes

```json
// WRONG - raw URL
"featured_image": "https://example.com/photo.jpg"

// CORRECT - $media syntax
"featured_image": {
  "$media": {
    "url": "https://example.com/photo.jpg",
    "alt": "Description"
  }
}

// WRONG - unknown byline reference
"bylines": [{ "byline": "author-1" }]

// CORRECT - define root bylines[] and reference byline IDs
"bylines": [{ "byline": "byline-author-1" }]
```

## 5.3 Seed File Structure

```json
{
	"$schema": "https://emdashcms.com/seed.schema.json",
	"version": "1",
	"meta": {
		"name": "Theme Name",
		"description": "Ported from WordPress theme"
	},

	"settings": {
		"title": "Site Title",
		"tagline": "Site tagline"
	},

	"collections": [
		{
			"slug": "posts",
			"label": "Posts",
			"fields": [
				{ "slug": "title", "type": "string", "required": true },
				{ "slug": "content", "type": "portableText" },
				{ "slug": "featured_image", "type": "image" }
			]
		}
	],

	"taxonomies": [
		{
			"name": "categories",
			"label": "Categories",
			"hierarchical": true,
			"collections": ["posts"],
			"terms": [{ "slug": "news", "label": "News" }]
		}
	],

	"bylines": [
		{
			"id": "byline-author-1",
			"slug": "theme-author",
			"displayName": "Theme Author"
		}
	],

	"menus": [
		{
			"name": "primary",
			"label": "Primary Navigation",
			"items": [
				{ "type": "custom", "label": "Home", "url": "/" },
				{ "type": "custom", "label": "Blog", "url": "/posts" }
			]
		}
	],

	"content": {
		"posts": [
			{
				"id": "post-1",
				"slug": "hello-world",
				"status": "published",
				"bylines": [{ "byline": "byline-author-1" }],
				"data": {
					"title": "Hello World",
					"content": [{ "_type": "block", "children": [{ "text": "Welcome!" }] }],
					"featured_image": {
						"$media": {
							"url": "file:./discovery/images/featured-1.jpg",
							"alt": "Featured image"
						}
					}
				}
			}
		]
	}
}
```

## 5.4 Adding Sections (Reusable Blocks)

If the theme has reusable block patterns, add them as sections:

```json
{
	"sections": [
		{
			"slug": "hero-centered",
			"title": "Centered Hero",
			"description": "Full-width hero with centered heading and CTA button",
			"keywords": ["hero", "banner", "header", "landing"],
			"content": [
				{
					"_type": "block",
					"style": "h1",
					"children": [{ "_type": "span", "text": "Welcome to Our Site" }]
				},
				{
					"_type": "block",
					"children": [{ "_type": "span", "text": "Your compelling tagline goes here." }]
				}
			]
		},
		{
			"slug": "newsletter-cta",
			"title": "Newsletter Signup",
			"keywords": ["newsletter", "subscribe", "email", "signup"],
			"content": [
				{
					"_type": "block",
					"style": "h3",
					"children": [{ "_type": "span", "text": "Subscribe to our newsletter" }]
				},
				{
					"_type": "block",
					"children": [
						{ "_type": "span", "text": "Get the latest updates delivered to your inbox." }
					]
				}
			]
		}
	]
}
```

Editors can insert these sections using the `/section` slash command in the rich text editor.

## 5.5 Add Redirects for Legacy WordPress URLs

Include redirects in the seed when the WordPress theme used different URL structures.

```json
{
	"redirects": [
		{ "source": "/?p=123", "destination": "/hello-world" },
		{ "source": "/2024/01/hello-world", "destination": "/hello-world", "type": 301 },
		{ "source": "/category/news", "destination": "/categories/news" }
	]
}
```

Rules:

- `source` and `destination` must be local paths (start with `/`)
- Supported `type` values are `301`, `302`, `307`, `308`
- Redirects are idempotent during seeding (existing `source` entries are skipped)

See `references/emdash-api.md` for full seed file schema.
