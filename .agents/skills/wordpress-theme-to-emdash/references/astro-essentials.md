# Astro Essentials for Theme Porters

A great EmDash theme is a great Astro site. This reference covers Astro fundamentals for building high-quality themes.

**EmDash targets Astro 6.** This document reflects Astro 6 APIs and patterns.

## Core Concepts

### Component-Based Architecture

Astro components (`.astro` files) are the building blocks. They have two parts:

1. **Component Script** (frontmatter) - Server-side TypeScript or JavaScript between `---` fences
2. **Component Template** - HTML with JSX-like expressions

```astro
---
// Component Script - runs at build/request time, never in browser
import Header from "../components/Header.astro";
import { getEmDashCollection } from "emdash";

const { entries: posts } = await getEmDashCollection("posts");
const { title } = Astro.props;
---
<!-- Component Template -->
<Header />
<h1>{title}</h1>
<ul>
  {posts.map(post => <li>{post.data.title}</li>)}
</ul>
```

**Key points:**

- Frontmatter code is NEVER sent to the browser
- Components render to HTML by default (zero JS)
- Use `async/await` and TypeScript freely in frontmatter
- Server-side imports (components, data, utilities) go in frontmatter
- Client-side JS can be imported in script tags or framework components. Script tag content is transpiled and bundled automatically.

### Zero JavaScript by Default

Astro components ship NO JavaScript to the browser unless you explicitly add it:

```astro
---
// This runs on the server only
const data = await fetchData();
---
<div>{data.title}</div>

<!-- Client-side JS must be explicit -->
<script>
  // This runs in the browser
  document.querySelector('button').addEventListener('click', () => {
    console.log('clicked');
  });
</script>
```

### Props and Slots

Components receive data via props and children via slots:

```astro
---
// Card.astro
interface Props {
  title: string;
  featured?: boolean;
}
const { title, featured = false } = Astro.props;
---
<article class:list={["card", { featured }]}>
  <h2>{title}</h2>
  <slot /> <!-- Children go here -->
  <slot name="footer" /> <!-- Named slot -->
</article>
```

Usage:

```astro
<Card title="Hello" featured>
  <p>Card content goes in default slot</p>
  <footer slot="footer">Footer content</footer>
</Card>
```

## Project Structure

Standard Astro project layout for EmDash themes:

```
src/
├── components/        # Reusable UI components
│   ├── Header.astro
│   ├── Footer.astro
│   ├── PostCard.astro
│   └── Sidebar.astro
├── layouts/           # Page layouts
│   └── Base.astro     # Main HTML shell
├── pages/             # File-based routing
│   ├── index.astro    # Homepage (/)
│   ├── 404.astro      # Not found page
│   ├── posts/
│   │   ├── index.astro      # Post archive (/posts)
│   │   └── [slug].astro     # Single post (/posts/hello-world)
│   └── pages/
│       └── [slug].astro     # CMS pages (/pages/about)
├── styles/
│   └── global.css     # Global styles
└── live.config.ts     # EmDash content collections
```

## Routing

### File-Based Routing

Files in `src/pages/` become routes:

| File                          | Route                |
| ----------------------------- | -------------------- |
| `src/pages/index.astro`       | `/`                  |
| `src/pages/about.astro`       | `/about`             |
| `src/pages/blog/index.astro`  | `/blog`              |
| `src/pages/blog/[slug].astro` | `/blog/hello-world`  |
| `src/pages/[...slug].astro`   | Catch-all (any path) |
| `src/pages/404.astro`         | 404 page             |

### Dynamic Routes

For CMS content, use dynamic routes with `[param]` syntax:

```astro
---
// src/pages/posts/[slug].astro
// NOTE: EmDash pages are always server-rendered (no getStaticPaths)
import { getEmDashEntry } from "emdash";
import Base from "../../layouts/Base.astro";
import { PortableText } from "emdash/ui";

const { slug } = Astro.params;
const { entry: post, error } = await getEmDashEntry("posts", slug!);

if (error) {
  return new Response("Server error", { status: 500 });
}

if (!post) {
  return Astro.redirect("/404");
}
---
<Base title={post.data.title}>
  <h1>{post.data.title}</h1>
  <PortableText value={post.data.content} />
</Base>
```

### Server Rendering (Required)

**EmDash pages must be server-rendered.** Never use `getStaticPaths()` or `export const prerender = true` for EmDash content pages. Content changes at runtime through the admin UI, so pages must be rendered on each request to reflect those changes.

```javascript
// astro.config.mjs
import node from "@astrojs/node";

export default defineConfig({
	output: "server", // Required for EmDash
	adapter: node({ mode: "standalone" }),
});
```

**Hybrid** - Mix of static and server pages:

```javascript
// astro.config.mjs
export default defineConfig({
	output: "static",
	adapter: node({ mode: "standalone" }),
});

// Then in specific pages:
export const prerender = false; // Render on request
```

Remember - any prerendered (static) pages will NOT reflect content changes until the site is rebuilt, so should only be used for pages that contain no EmDash CMS data.

## Layouts

Layouts wrap pages with common HTML structure:

```astro
---
// src/layouts/Base.astro
import { getSiteSettings, getMenu } from "emdash";
import "../styles/global.css";

interface Props {
  title?: string;
  description?: string;
}

const { title, description } = Astro.props;
const settings = await getSiteSettings();
const primaryMenu = await getMenu("primary");

const pageTitle = title ? `${title} | ${settings.title}` : settings.title;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description || settings.tagline} />
    <title>{pageTitle}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <header>
      <a href="/" class="logo">{settings.title}</a>
      {primaryMenu && (
        <nav>
          {primaryMenu.items.map(item => (
            <a
              href={item.url}
              aria-current={Astro.url.pathname === item.url ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      )}
    </header>

    <main>
      <slot /> <!-- Page content inserted here -->
    </main>

    <footer>
      <p>&copy; {new Date().getFullYear()} {settings.title}</p>
    </footer>
  </body>
</html>
```

## Styling

### Scoped Styles

Styles in `<style>` tags are scoped to the component:

```astro
<article class="card">
  <h2>Title</h2>
</article>

<style>
  /* Only affects this component's .card */
  .card {
    padding: 1rem;
    border: 1px solid #ddd;
  }

  /* Target slotted/child content with :global() */
  .card :global(p) {
    margin-bottom: 1em;
  }
</style>
```

### Global Styles

For site-wide styles, import a CSS file:

```astro
---
// In layout
import "../styles/global.css";
---
```

### CSS Variables

Use CSS custom properties for theming:

```css
/* global.css */
:root {
	/* Colors */
	--color-base: #ffffff;
	--color-contrast: #1a1a1a;
	--color-primary: #0073aa;
	--color-muted: #6b7280;
	--color-border: #e5e7eb;

	/* Typography */
	--font-body: system-ui, sans-serif;
	--font-heading: Georgia, serif;
	--font-mono: "Fira Code", monospace;

	/* Spacing */
	--space-1: 0.25rem;
	--space-2: 0.5rem;
	--space-4: 1rem;
	--space-8: 2rem;
	--space-16: 4rem;

	/* Layout */
	--content-width: 720px;
	--wide-width: 1200px;
}
```

### class:list Directive

Conditionally apply classes:

```astro
---
const { featured, size = "medium" } = Astro.props;
---
<article class:list={[
  "card",
  size,
  { featured, "has-image": !!image }
]}>
```

## Template Expressions

### Conditionals

```astro
{showTitle && <h1>{title}</h1>}

{condition ? <A /> : <B />}

{items.length > 0 ? (
  <ul>{items.map(item => <li>{item}</li>)}</ul>
) : (
  <p>No items found.</p>
)}
```

### Loops

```astro
{posts.map(post => (
  <article>
    <h2>{post.data.title}</h2>
  </article>
))}

{categories.map((cat, index) => (
  <span>
    {index > 0 && ", "}
    <a href={`/categories/${cat.slug}`}>{cat.label}</a>
  </span>
))}
```

### Async in Templates

You can use async operations directly in templates:

```astro
---
import { getMenu } from "emdash";
---
{await getMenu("sidebar").then(menu =>
  menu?.items.map(item => (
    <a href={item.url}>{item.label}</a>
  ))
)}
```

### Fragments

Group elements without a wrapper:

```astro
{posts.map(post => (
  <>
    <h2>{post.data.title}</h2>
    <p>{post.data.excerpt}</p>
  </>
))}

<!-- Or use Fragment for slots -->
<Fragment slot="header">
  <h1>Title</h1>
  <p>Subtitle</p>
</Fragment>
```

## Client-Side Interactivity

### Script Tags

For simple interactivity, use `<script>` tags:

```astro
<button id="menu-toggle">Menu</button>
<nav id="mobile-menu" hidden>...</nav>

<script>
  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('mobile-menu');

  toggle?.addEventListener('click', () => {
    menu?.toggleAttribute('hidden');
  });
</script>
```

Scripts are bundled and deduplicated automatically.

### Framework Components (Islands)

For complex interactivity, use framework components with client directives:

```astro
---
import SearchWidget from "../components/SearchWidget.jsx";
import ImageGallery from "../components/ImageGallery.svelte";
---

<!-- Hydrate when visible -->
<SearchWidget client:visible />

<!-- Hydrate immediately -->
<ImageGallery client:load images={images} />

<!-- Hydrate when idle -->
<Comments client:idle postId={post.id} />

<!-- Only hydrate on specific media query -->
<MobileMenu client:media="(max-width: 768px)" />
```

**Client directives:**

| Directive        | When it hydrates          |
| ---------------- | ------------------------- |
| `client:load`    | Page load (immediate)     |
| `client:idle`    | Browser is idle           |
| `client:visible` | Component enters viewport |
| `client:media`   | Media query matches       |
| `client:only`    | Skip SSR, client-only     |

## Astro Native Features

Prefer Astro's built-in features over third-party alternatives. They're optimized for Astro's architecture and work seamlessly with SSG/SSR.

### Images (astro:assets)

Astro's image service optimizes images at build time:

```astro
---
import { Image, Picture } from "astro:assets";
import heroImage from "../images/hero.jpg";
---

<!-- Basic optimized image -->
<Image src={heroImage} alt="Hero" width={1200} height={600} />

<!-- Responsive with multiple formats -->
<Picture
  src={heroImage}
  formats={["avif", "webp"]}
  alt="Hero"
  widths={[400, 800, 1200]}
  sizes="(max-width: 800px) 100vw, 800px"
/>
```

**Key features:**

- Automatic format conversion (WebP, AVIF)
- Lazy loading by default
- Prevents CLS with width/height
- Works with local and remote images

**For CMS/dynamic images** (not in `src/`), use standard `<img>` with manual optimization:

```astro
{post.data.featured_image && (
  <img
    src={post.data.featured_image.src}
    alt={post.data.featured_image.alt || post.data.title}
    width={post.data.featured_image.width}
    height={post.data.featured_image.height}
    loading="lazy"
    decoding="async"
  />
)}
```

### Fonts

Astro 6 includes experimental font optimization:

```javascript
// astro.config.mjs
export default defineConfig({
	experimental: {
		fonts: true,
	},
});
```

```astro
---
import { Font } from "astro:fonts";
---
<head>
  <Font
    family="Inter"
    weights={[400, 500, 600, 700]}
    styles={["normal", "italic"]}
    display="swap"
    preload
  />
</head>

<style>
  body {
    font-family: "Inter", system-ui, sans-serif;
  }
</style>
```

**Benefits over manual font loading:**

- Automatic `font-display: swap`
- Preload hints generated automatically
- Self-hosted fonts (no Google Fonts privacy concerns, and no external CSP required)
- Subset to used characters (smaller files)

### Content Security Policy (CSP)

CSP is enabled by default in EmDash. Astro provides the `Astro.csp` API for managing security headers.

**Default behavior:**

- Scripts and styles get automatic nonces
- Inline scripts/styles are allowed via nonces
- External resources require explicit allowlisting

**Hardening CSP per route:**

```astro
---
// Restrict this page to only same-origin resources
Astro.csp.script.add("'self'");
Astro.csp.style.add("'self'");
Astro.csp.img.add("'self'");
Astro.csp.font.add("'self'");

// Allow specific external resources
Astro.csp.script.add("https://analytics.example.com");
Astro.csp.img.add("https://images.unsplash.com");
Astro.csp.font.add("https://fonts.gstatic.com");

// For iframes/embeds
Astro.csp.frame.add("https://www.youtube.com");
Astro.csp.frame.add("https://player.vimeo.com");
---
```

**Common CSP patterns for themes:**

```astro
---
// Allow Google Fonts
Astro.csp.style.add("https://fonts.googleapis.com");
Astro.csp.font.add("https://fonts.gstatic.com");

// Allow embedded videos
Astro.csp.frame.add("https://www.youtube.com");
Astro.csp.frame.add("https://www.youtube-nocookie.com");
Astro.csp.frame.add("https://player.vimeo.com");

// Allow analytics (if needed)
Astro.csp.script.add("https://www.googletagmanager.com");
Astro.csp.connect.add("https://www.google-analytics.com");
---
```

**Important:** When porting WordPress themes that embed external content (YouTube, social media, maps), remember to add appropriate CSP rules.

### Prefetching

Astro can prefetch links automatically for faster navigation:

```javascript
// astro.config.mjs
export default defineConfig({
	prefetch: {
		prefetchAll: true, // Prefetch all links
		defaultStrategy: "hover", // or "viewport", "load"
	},
});
```

Control per-link:

```astro
<!-- Disable prefetch for external links -->
<a href="https://external.com" data-astro-prefetch="false">External</a>

<!-- Force prefetch on viewport enter -->
<a href="/important" data-astro-prefetch="viewport">Important</a>
```

### View Transitions

For SPA-like navigation without full page reloads:

```astro
---
// In layout
import { ClientRouter } from "astro:transitions";
---
<head>
  <ClientRouter />
</head>

<!-- Elements persist across navigation -->
<header transition:persist>
  <nav>...</nav>
</header>

<!-- Named transitions for animations -->
<article transition:name="post-content">
  <h1 transition:name={`post-${post.id}`}>{post.data.title}</h1>
</article>
```

### Environment Variables

Use `astro:env` for type-safe environment variables:

```javascript
// astro.config.mjs
import { defineConfig, envField } from "astro/config";

export default defineConfig({
	env: {
		schema: {
			SITE_URL: envField.string({ context: "client", access: "public" }),
			API_SECRET: envField.string({ context: "server", access: "secret" }),
		},
	},
});
```

```astro
---
import { SITE_URL, API_SECRET } from "astro:env/server";

// API_SECRET only available server-side
const data = await fetch(API_SECRET + "/endpoint");
---
<!-- SITE_URL can be used in templates -->
<meta property="og:url" content={SITE_URL} />
```

### Middleware

For cross-cutting concerns (auth, redirects, headers):

```typescript
// src/middleware.ts
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
	// Before the route handler
	const start = Date.now();

	// Add custom headers
	context.response.headers.set("X-Custom-Header", "value");

	// Continue to route
	const response = await next();

	// After the route handler
	console.log(`${context.url.pathname} took ${Date.now() - start}ms`);

	return response;
});
```

### Actions

For type-safe form handling and mutations:

```typescript
// src/actions/index.ts
import { defineAction } from "astro:actions";
import { z } from "astro/zod";

export const server = {
	subscribe: defineAction({
		input: z.object({
			email: z.email(),
		}),
		handler: async ({ email }) => {
			// Add to newsletter
			await addSubscriber(email);
			return { success: true };
		},
	}),
};
```

```astro
---
import { actions } from "astro:actions";
---
<form method="POST" action={actions.subscribe}>
  <input type="email" name="email" required />
  <button type="submit">Subscribe</button>
</form>
```

````

## Common Patterns

### Navigation with Active State

```astro
---
const currentPath = Astro.url.pathname;

function isActive(href: string) {
  if (href === "/") return currentPath === "/";
  return currentPath.startsWith(href);
}
---
<nav>
  {menu.items.map(item => (
    <a
      href={item.url}
      class:list={[{ active: isActive(item.url) }]}
      aria-current={isActive(item.url) ? "page" : undefined}
    >
      {item.label}
    </a>
  ))}
</nav>
````

### Date Formatting

```astro
---
const date = post.data.publishedAt;
const formatted = date?.toLocaleDateString("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});
---
<time datetime={date?.toISOString()}>{formatted}</time>
```

### Responsive Images

```astro
<picture>
  <source
    media="(min-width: 768px)"
    srcset={`${image.src}?w=1200`}
  />
  <img
    src={`${image.src}?w=600`}
    alt={image.alt}
    loading="lazy"
  />
</picture>
```

### Error Handling

```astro
---
import { getEmDashEntry } from "emdash";

const { entry: post } = await getEmDashEntry("posts", Astro.params.slug);

if (!post) {
  return Astro.redirect("/404");
}
---
```

## Best Practices

### Performance

1. **Minimize client JS** - Use Astro components over framework components when possible
2. **Lazy load images** - Use Astro image component, or add `loading="lazy"` to below-fold images
3. **Preconnect fonts** - Use Astro Font API, or add preconnect hints for external fonts
4. **Use CSS** - Prefer CSS animations over JS

### Accessibility

1. **Semantic HTML** - Use proper heading hierarchy, landmarks
2. **Alt text** - Always provide meaningful alt text for images. For purely decorative images, use empty alt (`alt=""`)
3. **ARIA** - Use `aria-current="page"` for active nav links
4. **Skip links** - Add skip to content link for keyboard users
5. **Focus styles** - Don't remove focus outlines

### SEO

1. **Unique titles** - Each page should have a unique `<title>`. Pass this via layout props
2. **Meta descriptions** - Provide descriptions for all pages
3. **Canonical URLs** - Add canonical links for duplicate content
4. **Structured data** - Add JSON-LD for rich snippets

### Code Organization

1. **Small components** - Keep components focused on one thing
2. **Consistent naming** - Use PascalCase for components
3. **Co-locate styles** - Keep styles with their components
4. **Extract utilities** - Move shared logic to `src/utils/`

## Astro Content Collections vs EmDash Collections

EmDash uses Astro's **live content collections** under the hood, but provides a higher-level API optimized for CMS workflows.

### Astro Content Collections

Astro 5+ introduced the Content Layer API with two types of collections:

**Build-time collections** - Data fetched at build time, stored in a data layer:

```typescript
// src/content.config.ts
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const blog = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
	schema: z.object({
		title: z.string(),
		pubDate: z.coerce.date(),
	}),
});

export const collections = { blog };
```

Query with `getCollection()` and `getEntry()` from `astro:content`.

**Live collections** - Data fetched at request time, not persisted:

```typescript
// src/content.config.ts (or src/live.config.ts)
import { defineLiveCollection } from "astro:content";

const products = defineLiveCollection({
	loader: async () => {
		const res = await fetch("https://api.example.com/products");
		return res.json();
	},
});
```

Query with `getLiveCollection()` from `astro:content`.

### EmDash Collections

EmDash wraps Astro's live collection system with a database-backed loader:

```typescript
// src/live.config.ts
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
```

This single `_emdash` collection handles ALL content types. EmDash then provides its own query functions that filter by collection:

```typescript
import { getEmDashCollection, getEmDashEntry } from "emdash";

// These query the _emdash live collection, filtering by type
const { entries: posts } = await getEmDashCollection("posts");
const { entry: page } = await getEmDashEntry("pages", "about");
```

### Key Differences

| Aspect                 | Astro Collections               | EmDash Collections                          |
| ---------------------- | ------------------------------- | ------------------------------------------- |
| **Config file**        | `src/content.config.ts`         | `src/live.config.ts`                        |
| **Schema definition**  | In config file with Zod         | In EmDash admin UI or seed file             |
| **Data source**        | Files, APIs, custom loaders     | SQLite database                             |
| **Query functions**    | `getCollection()`, `getEntry()` | `getEmDashCollection()`, `getEmDashEntry()` |
| **Content editing**    | Edit source files directly      | Admin UI or API                             |
| **Type safety**        | Generated from schema           | Runtime validation                          |
| **Rendering Markdown** | `render()` from `astro:content` | `<PortableText />` component                |

### When to Use Which

You can mix both systems, but generally:

**Use Astro's built-in collections when:**

- Content is stored as local Markdown/MDX files
- You want build-time type generation from schemas
- Content is managed by developers in version control

**Use EmDash collections when:**

- Content is managed by non-developers via admin UI
- You need WordPress-style features (menus, taxonomies, widgets)
- Content comes from WordPress migration
- You want a unified CMS experience

### Mixing Both

You can use both in the same project:

```typescript
// src/content.config.ts - Build-time collections
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
});

export const collections = { docs };
```

```typescript
// src/live.config.ts - EmDash collections
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";
import { liveYouTubeLoader } from "@ascorbic/youtube-loader";

const playlistVideos = defineLiveCollection({
	type: "live",
	loader: liveYouTubeLoader({
		type: "playlist",
		apiKey: import.meta.env.YOUTUBE_API_KEY,
		playlistId: "PLqGQbXn_GDmnHxd6p_tTlN3d5pMhTjy8g",
		defaultMaxResults: 50,
	}),
});

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
	playlistVideos,
};
```

```astro
---
// Use both in pages
import { getCollection } from "astro:content";
import { getEmDashCollection } from "emdash";

const docs = await getCollection("docs");                // Astro collection
const { entries: posts } = await getEmDashCollection("posts"); // EmDash collection
---
```

### Content Rendering Comparison

**Astro Markdown/MDX:**

```astro
---
import { getEntry, render } from "astro:content";

const post = await getEntry("blog", "hello-world");
const { Content } = await render(post);
---
<Content />
```

**EmDash Portable Text:**

```astro
---
import { getEmDashEntry } from "emdash";
import { PortableText } from "emdash/ui";

const { entry: post } = await getEmDashEntry("posts", "hello-world");
---
{post && <PortableText value={post.data.content} />}
```

EmDash uses Portable Text (structured JSON) instead of Markdown, enabling:

- Rich text editing in the admin UI
- Custom block types (embeds, galleries, etc.)
- No build step for content changes

## Astro 6 Specifics

### Requirements

- **Node 22.12.0+** required (Node 18 and 20 dropped)
- **Vite 7** under the hood
- **Zod 4** for schemas

### Key Changes from Astro 5

#### Content Collections

Legacy content collections are removed. All collections must use the Content Layer API:

```typescript
// OLD - No longer works
// Files in src/content/ with type: 'content'

// NEW - Content Layer API
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({ ... }),
});
```

#### Zod 4 Syntax

```typescript
import { z } from "astro/zod";

// Changed validators
z.email(); // was z.string().email()
z.url(); // was z.string().url()
z.uuid(); // was z.string().uuid()

// Error messages
z.string().min(5, { error: "Too short" }); // was { message: "..." }

// Default with transforms - must match output type
z.string().transform(Number).default(0); // was .default("0")
```

#### View Transitions

```astro
---
// OLD
import { ViewTransitions } from "astro:transitions";

// NEW
import { ClientRouter } from "astro:transitions";
---
<head>
  <ClientRouter />
</head>
```

#### Removed APIs

- `Astro.glob()` - Use `import.meta.glob()` or content collections
- `entry.render()` - Use `render(entry)` from `astro:content`
- `entry.slug` - Use `entry.id` (Content Layer API)

#### Image Handling

Default image service now crops by default and never upscales:

```astro
<Image
  src={myImage}
  width={800}
  height={600}
  fit="cover"      // Now default, was "inside"
/>
```

### Configuration

```javascript
// astro.config.mjs
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server", // Required for EmDash
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(), // For admin UI
		emdash({
			database: sqlite({ url: "file:./data.db" }),
		}),
	],
});
```

### TypeScript Config

Astro 6 requires these settings for content collections:

```json
{
	"extends": "astro/tsconfigs/strict",
	"compilerOptions": {
		"strictNullChecks": true,
		"allowJs": true
	}
}
```

### Migration Checklist

When porting themes to Astro 6:

- [ ] Ensure Node 22+ in deployment environment
- [ ] Update Zod schemas to v4 syntax
- [ ] Replace `ViewTransitions` with `ClientRouter`
- [ ] Replace `Astro.glob()` with `import.meta.glob()`
- [ ] Use `render(entry)` instead of `entry.render()`
- [ ] Check image sizing behavior if using Astro Image
- [ ] Test any Vite plugins for v7 compatibility
