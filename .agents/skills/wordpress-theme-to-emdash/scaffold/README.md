# EmDash Theme Scaffold

This is a minimal, working EmDash theme that demonstrates correct patterns for:

- **Site settings** - Use `getSiteSettings()` for title, tagline, logo - never hard-code
- **Menus** - Use `getMenu()` for navigation - never hard-code links
- **Image fields** - Always access `.src` and `.alt`, never the field directly
- **Taxonomy terms** - Use `getEntryTerms()` without a db parameter
- **PortableText** - Use the `<PortableText>` component from `emdash/ui`

## Critical: No Hard-Coded Content

The theme is a shell that displays CMS content. Never hard-code:

- Site title or tagline (use `settings.title`, `settings.tagline`)
- Navigation links (use `getMenu("primary")`)
- Logo or favicon (use `settings.logo`, `settings.favicon`)
- Footer content (use site settings or widget areas)

## Usage

When porting a WordPress theme:

1. Copy this scaffold to your theme directory
2. Run `pnpm install` from monorepo root
3. Verify it builds: `pnpm --filter your-theme build`
4. Use these templates as reference for correct API usage

## Key Patterns

### Image Fields

```astro
{/* CORRECT - check .src exists */}
{post.data.featured_image?.src && (
  <img
    src={post.data.featured_image.src}
    alt={post.data.featured_image.alt || post.data.title}
  />
)}

{/* WRONG - field is an object, not a string */}
{post.data.featured_image && (
  <img src={post.data.featured_image} />  // Renders [object Object]
)}
```

### Taxonomy Terms

```astro
{/* CORRECT - no db parameter */}
const categories = await getEntryTerms("posts", post.id, "categories");

{/* WRONG - db is not a parameter */}
const categories = await getEntryTerms("posts", post.id, "categories", db);
```

### Seed File Images

```json
{
	"featured_image": {
		"$media": {
			"url": "https://example.com/image.jpg",
			"alt": "Description",
			"filename": "image.jpg"
		}
	}
}
```

At runtime, this becomes `{ src: "...", alt: "..." }`.

## Files

```
scaffold/
├── package.json           # Working dependency versions
├── astro.config.mjs       # Minimal config
├── tsconfig.json
├── src/
│   ├── env.d.ts
│   ├── live.config.ts     # Collection loader setup
│   ├── styles/global.css  # Minimal styles with comments
│   ├── layouts/Base.astro # Header, footer, menus
│   ├── components/
│   │   └── PostCard.astro # Image field handling example
│   └── pages/
│       ├── index.astro
│       ├── 404.astro
│       ├── posts/
│       │   ├── index.astro
│       │   └── [slug].astro  # Taxonomy terms example
│       ├── pages/[slug].astro
│       ├── categories/[slug].astro
│       └── tags/[slug].astro
├── public/
│   └── favicon.svg
└── .emdash/
    └── seed.json          # All field types demonstrated
```
