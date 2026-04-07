# Phase 3: Template Conversion

Convert WordPress PHP templates to Astro components.

## 3.1 Analyze Theme Structure

Read `functions.php` to identify:

- `register_nav_menu()` → EmDash menus
- `register_sidebar()` → EmDash widget areas
- `add_theme_support()` → Features (thumbnails, formats, etc.)
- `register_post_type()` → Collections
- `register_taxonomy()` → EmDash taxonomy defs
- `add_shortcode()` → Portable Text blocks

## 3.2 Template Mapping

| WP Template    | Astro Route                         |
| -------------- | ----------------------------------- |
| `index.php`    | `src/pages/index.astro`             |
| `single.php`   | `src/pages/posts/[slug].astro`      |
| `page.php`     | `src/pages/pages/[slug].astro`      |
| `archive.php`  | `src/pages/posts/index.astro`       |
| `category.php` | `src/pages/categories/[slug].astro` |
| `tag.php`      | `src/pages/tags/[slug].astro`       |
| `search.php`   | `src/pages/search.astro`            |
| `404.php`      | `src/pages/404.astro`               |
| `header.php`   | Component in layout                 |
| `footer.php`   | Component in layout                 |

## 3.3 Convert Templates

### The Loop → getEmDashCollection

```php
// WordPress
<?php while (have_posts()) : the_post(); ?>
  <h2><?php the_title(); ?></h2>
<?php endwhile; ?>
```

```astro
---
// Astro/EmDash
import { getEmDashCollection } from "emdash";
const { entries: posts } = await getEmDashCollection("posts");
---
{posts.map(post => <h2>{post.data.title}</h2>)}
```

### Single Post → getEmDashEntry

```php
// WordPress
<?php the_content(); ?>
```

```astro
---
// Astro/EmDash
import { getEmDashEntry } from "emdash";
import { PortableText } from "emdash/ui";
const { entry: post } = await getEmDashEntry("posts", Astro.params.slug);
---
{post && <PortableText value={post.data.content} />}
```

## 3.4 Page Templates

WordPress themes often register page templates (Full Width, Sidebar, Landing Page, etc.). In EmDash, this is a `select` field on the pages collection:

1. Add a `template` select field to the pages collection with the theme's template names as options (e.g. "Default", "Full Width", "Landing Page")
2. Create an Astro layout component for each template in `src/layouts/`
3. Map the field value to a layout component in the page route:

```astro
---
// src/pages/pages/[slug].astro
import { getEmDashEntry } from "emdash";
import PageDefault from "../../layouts/PageDefault.astro";
import PageFullWidth from "../../layouts/PageFullWidth.astro";

const { slug } = Astro.params;
const { entry: page } = await getEmDashEntry("pages", slug!);
if (!page) return Astro.redirect("/404");

const layouts = {
  "Default": PageDefault,
  "Full Width": PageFullWidth,
};
const Layout = layouts[page.data.template as keyof typeof layouts] ?? PageDefault;
---
<Layout page={page} />
```

Use human-readable option names (matching what the WP theme displayed) since these appear in the admin dropdown.

## Important: Server-Rendered Pages

**Never use `getStaticPaths()` or `export const prerender = true` for EmDash content pages.** Content changes at runtime, so pages must be server-rendered.

```astro
---
// CORRECT - server-rendered
const { slug } = Astro.params;
const { entry: post } = await getEmDashEntry("posts", slug!);

if (!post) {
  return Astro.redirect("/404");
}
---
```

See `references/template-patterns.md` for more conversion patterns.
