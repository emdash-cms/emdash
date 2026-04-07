# WP Theme → EmDash Concept Mapping

## Template Hierarchy

| WP Template               | Purpose                 | EmDash Equivalent                                       |
| ------------------------- | ----------------------- | ------------------------------------------------------- |
| `index.php`               | Fallback for everything | `src/pages/index.astro`                                 |
| `front-page.php`          | Static front page       | `src/pages/index.astro`                                 |
| `home.php`                | Blog posts page         | `src/pages/index.astro` or `src/pages/blog/index.astro` |
| `single.php`              | Single post             | `src/pages/posts/[slug].astro`                          |
| `single-{post_type}.php`  | Custom post type single | `src/pages/{type}/[slug].astro`                         |
| `page.php`                | Single page             | `src/pages/pages/[slug].astro`                          |
| `page-{slug}.php`         | Specific page template  | `src/pages/pages/{slug}.astro` (static)                 |
| `archive.php`             | Post archives           | `src/pages/posts/index.astro`                           |
| `archive-{post_type}.php` | CPT archive             | `src/pages/{type}/index.astro`                          |
| `category.php`            | Category archive        | `src/pages/categories/[slug].astro`                     |
| `tag.php`                 | Tag archive             | `src/pages/tags/[slug].astro`                           |
| `author.php`              | Author archive          | `src/pages/authors/[slug].astro`                        |
| `date.php`                | Date archive            | `src/pages/archive/[year]/[month].astro`                |
| `search.php`              | Search results          | `src/pages/search.astro` (use `search()` API)           |
| `404.php`                 | Not found               | `src/pages/404.astro`                                   |
| `header.php`              | Site header             | Part of `src/layouts/Base.astro`                        |
| `footer.php`              | Site footer             | Part of `src/layouts/Base.astro`                        |
| `sidebar.php`             | Sidebar widget area     | Component: `src/components/Sidebar.astro`               |
| `comments.php`            | Comments template       | Component or third-party (Giscus, etc.)                 |

## Template Parts

| WP Pattern                                                 | EmDash Pattern               |
| ---------------------------------------------------------- | ---------------------------- |
| `get_template_part('content', 'post')`                     | `<PostCard />` component     |
| `get_template_part('template-parts/header/site-branding')` | `<SiteBranding />` component |
| `template-parts/` directory                                | `src/components/` directory  |

## Functions.php Registrations

### Navigation Menus

```php
// WordPress
register_nav_menus([
  'primary' => 'Primary Menu',
  'footer' => 'Footer Menu',
]);
```

EmDash has first-class menu support with automatic URL resolution:

```typescript
import { getMenu } from "emdash";

const primaryMenu = await getMenu("primary");
// Returns { id, name, label, items: MenuItem[] }
// Items have resolved URLs and support nesting
```

Menus are created via:

- Admin UI
- Seed files (JSON)
- WordPress import (automatic migration)

### Sidebars/Widget Areas

```php
// WordPress
register_sidebar([
  'name' => 'Main Sidebar',
  'id' => 'sidebar-1',
]);
```

EmDash has first-class widget area support:

```typescript
import { getWidgetArea } from "emdash";

const sidebar = await getWidgetArea("sidebar");
// Returns { id, name, label, widgets: Widget[] }
// Widgets can be content (Portable Text), menu, or component
```

Widget areas are created via:

- Admin UI
- Seed files (JSON)
- WordPress import (automatic migration)

### Theme Support

```php
// WordPress
add_theme_support('post-thumbnails');
add_theme_support('title-tag');
add_theme_support('custom-logo');
add_theme_support('post-formats');
```

EmDash equivalents:

- `post-thumbnails` → `featured_image` field on collections (automatic)
- `title-tag` → Astro handles `<title>` in layout
- `custom-logo` → `getSiteSetting("logo")` returns `{ mediaId, alt, url }`
- `post-formats` → Field on collection (select type)

### Custom Post Types

```php
// WordPress
register_post_type('portfolio', [...]);
```

EmDash: Create collection via admin UI or API. The collection will be created during content import if it doesn't exist.

## Template Tags → EmDash

### Content Retrieval

| WP Function                   | EmDash Equivalent                                 |
| ----------------------------- | ------------------------------------------------- |
| `have_posts()` / `the_post()` | `getEmDashCollection()`                           |
| `get_post()`                  | `getEmDashEntry()`                                |
| `the_title()`                 | `post.data.title`                                 |
| `the_content()`               | `<PortableText value={post.data.content} />`      |
| `the_excerpt()`               | `post.data.excerpt`                               |
| `the_permalink()`             | `/posts/${post.id}` or `/posts/${post.data.slug}` |
| `the_post_thumbnail()`        | `post.data.featured_image`                        |
| `get_the_date()`              | `post.data.publishedAt`                           |
| `get_the_author()`            | `post.data.byline?.displayName`                   |
| `get_the_category()`          | `getEntryTerms(coll, id, "categories")`           |
| `get_the_tags()`              | `getEntryTerms(coll, id, "tags")`                 |

### Taxonomies

| WP Function                  | EmDash Equivalent                                  |
| ---------------------------- | -------------------------------------------------- |
| `get_categories()`           | `getTaxonomyTerms("categories")`                   |
| `get_tags()`                 | `getTaxonomyTerms("tags")`                         |
| `get_terms($taxonomy)`       | `getTaxonomyTerms(taxonomy)`                       |
| `get_term($id, $taxonomy)`   | `getTerm(taxonomy, slug)`                          |
| `get_term_by('slug', ...)`   | `getTerm(taxonomy, slug)`                          |
| `get_the_terms($post, $tax)` | `getEntryTerms(collection, entryId, taxonomy)`     |
| `wp_get_post_categories()`   | `getEntryTerms(collection, entryId, "categories")` |
| `wp_get_post_tags()`         | `getEntryTerms(collection, entryId, "tags")`       |
| `get_category_link($cat)`    | `/categories/${term.slug}`                         |
| `get_tag_link($tag)`         | `/tags/${term.slug}`                               |

EmDash supports hierarchical taxonomies (like categories) and flat taxonomies (like tags):

### Site Info

| WP Function               | EmDash Equivalent                       |
| ------------------------- | --------------------------------------- |
| `bloginfo('name')`        | `getSiteSetting("title")`               |
| `bloginfo('description')` | `getSiteSetting("tagline")`             |
| `home_url()`              | `Astro.site` or `import.meta.env.SITE`  |
| `get_theme_mod()`         | `getSiteSetting(key)` or plugin storage |
| `get_option()`            | `getSiteSetting(key)` or plugin storage |
| `get_custom_logo()`       | `getSiteSetting("logo")` returns URL    |

### Conditional Tags

| WP Function       | Astro Equivalent                   |
| ----------------- | ---------------------------------- |
| `is_home()`       | `Astro.url.pathname === '/'`       |
| `is_front_page()` | `Astro.url.pathname === '/'`       |
| `is_single()`     | Check route pattern                |
| `is_page()`       | Check route pattern                |
| `is_archive()`    | Check route pattern                |
| `is_category()`   | Check route pattern                |
| `is_search()`     | `Astro.url.pathname === '/search'` |
| `is_404()`        | N/A (404.astro handles this)       |

### Media

| WP Function                 | EmDash Equivalent          |
| --------------------------- | -------------------------- |
| `wp_get_attachment_image()` | `<img src={media.url} />`  |
| `wp_get_attachment_url()`   | `media.url`                |
| `the_post_thumbnail()`      | `post.data.featured_image` |

### Navigation

| WP Function              | EmDash Equivalent                     |
| ------------------------ | ------------------------------------- |
| `wp_nav_menu()`          | `getMenu("menu-name")` + render items |
| `wp_list_pages()`        | Query pages collection or use menu    |
| `the_posts_navigation()` | Custom pagination component           |
| `the_posts_pagination()` | Custom pagination component           |
| `get_nav_menu_items()`   | `getMenu("name").items`               |

## Hooks → EmDash Events

WordPress hooks don't have direct equivalents. Most hook functionality becomes:

1. **Astro middleware** - For request/response modification
2. **EmDash plugin hooks** - For content lifecycle events
3. **Build-time logic** - In Astro config or components

| WP Hook              | EmDash Approach                          |
| -------------------- | ---------------------------------------- |
| `wp_head`            | Add to `<head>` in layout                |
| `wp_footer`          | Add before `</body>` in layout           |
| `the_content` filter | PortableText components                  |
| `pre_get_posts`      | Query filters in `getEmDashCollection()` |
| `save_post`          | EmDash plugin hook: `content:beforeSave` |

## Asset Enqueueing

```php
// WordPress
wp_enqueue_style('theme-style', get_stylesheet_uri());
wp_enqueue_script('theme-script', get_template_directory_uri() . '/js/main.js');
```

Astro:

```astro
---
// In layout or component
import '../styles/main.css';
import '../scripts/main.js';
---
<link rel="stylesheet" href="/styles/main.css" />
<script src="/scripts/main.js"></script>
```

Or use Astro's built-in bundling:

```astro
<style>
  /* Scoped styles */
</style>
<script>
  // Client-side JS
</script>
```

## Shortcodes → Portable Text Blocks

```php
// WordPress shortcode
add_shortcode('gallery', function($atts) {
  return '<div class="gallery">...</div>';
});
// Usage: [gallery ids="1,2,3"]
```

EmDash: Custom Portable Text block type + component:

```astro
---
// GalleryBlock.astro
const { ids } = Astro.props;
---
<div class="gallery">
  <!-- Render images -->
</div>
```

```astro
<PortableText
  value={content}
  components={{ gallery: GalleryBlock }}
/>
```

## Widgets → Widget Areas

EmDash has first-class widget support with `getWidgetArea()`:

```typescript
import { getWidgetArea } from "emdash";

const sidebar = await getWidgetArea("sidebar");
sidebar?.widgets.forEach((widget) => {
	// widget.type: "content" | "menu" | "component"
});
```

### Widget Types

| WP Widget    | EmDash Widget Type              | Notes                         |
| ------------ | ------------------------------- | ----------------------------- |
| Text/HTML    | `content`                       | Portable Text (rich content)  |
| Custom Menu  | `menu`                          | References menu by name       |
| Recent Posts | `component` `core:recent-posts` | Built-in component with props |
| Categories   | `component` `core:categories`   | Built-in component            |
| Tag Cloud    | `component` `core:tag-cloud`    | Built-in component            |
| Search       | `<LiveSearch />` component      | Use `emdash/ui` LiveSearch    |
| Archives     | `component` `core:archives`     | Built-in component            |

### Core Widget Components

| Component ID        | Props                    |
| ------------------- | ------------------------ |
| `core:recent-posts` | `limit`, `collection`    |
| `core:categories`   | `taxonomy`, `showCounts` |
| `core:tag-cloud`    | `taxonomy`, `limit`      |
| `core:search`       | `placeholder`            |
| `core:archives`     | `collection`, `format`   |

## Search

WordPress search maps to EmDash's FTS5-based search system:

```php
// WordPress search form
get_search_form();

// WordPress search query
$results = new WP_Query(['s' => 'hello world']);
```

EmDash:

```typescript
import { search } from "emdash";
import LiveSearch from "emdash/ui/search";

// Programmatic search
const results = await search("hello world", {
  collections: ["posts", "pages"],
  limit: 20,
});

// Or use the LiveSearch component
<LiveSearch placeholder="Search..." />
```

### Search Page Pattern

```astro
---
// src/pages/search.astro
import { search } from "emdash";
import Base from "../layouts/Base.astro";

const query = Astro.url.searchParams.get("q") || "";
const results = query ? await search(query, { limit: 20 }) : { results: [] };
---
<Base title={`Search: ${query}`}>
  <h1>Search Results for "{query}"</h1>
  {results.results.length === 0 ? (
    <p>No results found.</p>
  ) : (
    <ul>
      {results.results.map(r => (
        <li>
          <a href={`/${r.collection}/${r.slug}`}>{r.title}</a>
          <p set:html={r.snippet} />
        </li>
      ))}
    </ul>
  )}
</Base>
```

### Search Features

| WordPress                    | EmDash                          |
| ---------------------------- | ------------------------------- |
| Basic keyword search         | FTS5 with Porter stemming       |
| Search all public post types | Per-collection search enable    |
| `s` query parameter          | `q` query parameter             |
| Relevance sorting            | BM25 ranking with field weights |
| Search widget                | `<LiveSearch />` component      |

**Note:** Search must be enabled per-collection in admin. Mark fields as "Searchable" to include them in the index.

## Reusable Blocks → Sections

WordPress reusable blocks (`wp_block` post type) map to EmDash sections:

```php
// WordPress - creating a reusable block
// Done via Gutenberg editor, saved as wp_block post type
```

EmDash:

```typescript
import { getSection, getSections } from "emdash";

// Get a specific section
const cta = await getSection("newsletter-cta");

// List sections by category
const heroes = await getSections({ category: "heroes" });
```

### Inserting Sections

In WordPress, you insert reusable blocks from the block inserter. In EmDash, editors use the `/section` slash command in the rich text editor.

### Section Sources

| Source   | Origin                                  |
| -------- | --------------------------------------- |
| `theme`  | Defined in seed file (theme patterns)   |
| `user`   | Created by editors in admin             |
| `import` | Imported from WordPress reusable blocks |

### Migration

WordPress `wp_block` posts are automatically imported as sections:

- Content converted from Gutenberg to Portable Text
- Placed in "Imported" category
- Source set to `"import"`
