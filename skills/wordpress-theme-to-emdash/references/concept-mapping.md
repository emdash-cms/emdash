# Map WordPress theme concepts to EmDash

Use this reference when translating WordPress theme structure into an EmDash-powered Astro site. The mappings identify the closest responsibility, not a line-for-line replacement.

For exact EmDash APIs and result shapes, read:

- [Querying and rendering](../../building-emdash-site/references/querying-and-rendering.md)
- [Site features](../../building-emdash-site/references/site-features.md)
- [Schema and seed files](../../building-emdash-site/references/schema-and-seed.md)
- [Creating plugins](../../creating-plugins/SKILL.md) when the source behavior is not presentation alone

## Template hierarchy

Astro routes are explicit. Recreate only the WordPress template branches needed by the target site.

| WordPress template          | Typical Astro destination                                | Notes                                                                                             |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `front-page.php`            | `src/pages/index.astro`                                  | Homepage                                                                                          |
| `home.php`                  | `src/pages/posts/index.astro`                            | Posts index when distinct from the homepage                                                       |
| `single.php`                | `src/pages/posts/[slug].astro`                           | Collection detail route                                                                           |
| `single-{post_type}.php`    | `src/pages/{collection}/[slug].astro`                    | Custom post type detail                                                                           |
| `page.php`                  | `src/pages/pages/[slug].astro`                           | CMS-managed page                                                                                  |
| `page-{slug}.php`           | Fixed route or a page-layout choice                      | Use a fixed route for truly unique behavior; use a schema field when editors choose the layout    |
| `archive.php`               | `src/pages/posts/index.astro`                            | Collection archive                                                                                |
| `archive-{post_type}.php`   | `src/pages/{collection}/index.astro`                     | Custom post type archive                                                                          |
| `category.php` / `tag.php`  | Taxonomy route such as `src/pages/category/[slug].astro` | Route names follow the target URL design                                                          |
| `author.php`                | Byline archive route                                     | EmDash bylines are independent of login accounts                                                  |
| `date.php`                  | Date archive route                                       | Implement only when the target site needs date archives                                           |
| `search.php`                | `src/pages/search.astro`                                 | Use EmDash search APIs or `LiveSearch`                                                            |
| `404.php`                   | `src/pages/404.astro`                                    | Not-found page                                                                                    |
| `header.php` / `footer.php` | Shared layout or components                              | Include EmDash head/body contribution components when the site supports plugin page contributions |
| `sidebar.php`               | Astro component or EmDash widget area                    | Choose based on whether editors manage the region                                                 |
| `comments.php`              | `Comments` and `CommentForm` from `emdash/ui/comments`   | Uses the collection name and `entry.data.id`                                                      |

WordPress template parts become ordinary Astro components. Template hierarchy fallbacks become explicit route or component decisions rather than implicit filename resolution.

## Registrations in `functions.php`

| WordPress registration                      | EmDash destination                   | Decision                                                                                   |
| ------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `register_post_type()`                      | Collection and fields                | Define through schema, seed, admin, or CLI—not system-table writes                         |
| `register_taxonomy()`                       | Taxonomy attached to collections     | Preserve hierarchy and use the exact taxonomy name in every query                          |
| `register_nav_menu()`                       | Named menu                           | Query the menu by its stable name, such as `primary` or `footer`                           |
| `register_sidebar()`                        | Widget area or fixed Astro component | Use a widget area only when editors need to manage its contents                            |
| `add_theme_support('post-thumbnails')`      | Image field                          | Render CMS media with `Image` from `emdash/ui`                                             |
| `add_theme_support('custom-logo')`          | `logo` site setting                  | The setting resolves to media metadata and a URL                                           |
| `add_theme_support('title-tag')`            | Layout metadata and `EmDashHead`     | Astro owns the document structure                                                          |
| `add_theme_support('post-formats')`         | Select field or separate collections | Choose based on whether formats share one content model                                    |
| `add_image_size()`                          | EmDash image variants or CSS layout  | Preserve the visual intent instead of WordPress attachment internals                       |
| `add_shortcode()` / `register_block_type()` | Content conversion plus a renderer   | A custom Portable Text block definition and Astro renderer require a trusted native plugin |

## Content and template tags

| WordPress concept          | EmDash or Astro equivalent                                   |
| -------------------------- | ------------------------------------------------------------ |
| The Loop                   | `getEmDashCollection()` and render `entries`                 |
| `get_post()`               | `getEmDashEntry(collection, slug)`                           |
| `the_title()`              | A collection field such as `entry.data.title`                |
| `the_content()`            | `<PortableText value={entry.data.content} />`                |
| `the_excerpt()`            | A schema field such as `entry.data.excerpt`                  |
| `the_permalink()`          | A route built with `entry.id`, which is the content slug     |
| `the_post_thumbnail()`     | An image field rendered with the EmDash `Image` component    |
| `get_the_date()`           | The relevant system date, usually `entry.data.publishedAt`   |
| `get_the_author()`         | `entry.data.byline` or `entry.data.bylines`                  |
| `get_the_terms()`          | `getEntryTerms(collection, entry.data.id, taxonomy)`         |
| `get_terms()`              | `getTaxonomyTerms(taxonomy)`                                 |
| `get_term_by('slug', ...)` | `getTerm(taxonomy, slug)`                                    |
| `WP_Query`                 | `getEmDashCollection()` filters, taxonomy helpers, or search |
| `wp_nav_menu()`            | `getMenu(name)` and semantic menu rendering                  |
| `dynamic_sidebar()`        | `<WidgetArea name="..." />` or `getWidgetArea(name)`         |
| `get_search_form()`        | `LiveSearch` or a site-owned search form                     |

Two identifiers are easy to confuse:

- `entry.id` is the slug used in URLs.
- `entry.data.id` is the database ID used by APIs such as taxonomy and comment lookups.

Content queries return a `cacheHint`. Pass it to `Astro.cache.set(cacheHint)` so publishing invalidates cached routes.

## Site information and Customizer values

| WordPress value                              | EmDash or project destination                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Site title and tagline                       | `getSiteSettings()` or `getSiteSetting()`                                              |
| Site icon and custom logo                    | `favicon` and `logo` site settings                                                     |
| Social links or site-wide editorial values   | Existing site setting when available; otherwise an explicit schema or project decision |
| Layout width, breakpoints, and visual tokens | Site CSS derived from theme source or reference evidence                               |
| Build-time implementation choice             | Astro configuration, not an invented CMS setting                                       |
| Plugin-owned user setting                    | `ctx.settings`; secret fields are encrypted by the host                                |
| Plugin-owned internal state                  | Plugin-scoped KV or declared storage                                                   |

Do not move every Customizer value into the CMS. Expose a setting only when an editor needs to change it independently of a deployment.

## Conditional tags

WordPress conditional tags become explicit route knowledge or data checks:

| WordPress condition             | Astro approach                                    |
| ------------------------------- | ------------------------------------------------- |
| `is_front_page()` / `is_home()` | The route being rendered, not a global query flag |
| `is_single()` / `is_page()`     | The current route and collection                  |
| `is_archive()`                  | The archive route component                       |
| `is_category()` / `is_tag()`    | The taxonomy route and resolved term              |
| `is_search()`                   | The search route                                  |
| `is_404()`                      | `404.astro`                                       |

Prefer route-specific components over repeated pathname checks when the router already establishes the page kind.

## Hooks and runtime behavior

Theme presentation stays in Astro. Behavior that reacts to CMS events or requires runtime authority belongs in a plugin.

| WordPress hook or behavior           | EmDash destination                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `wp_head` for static theme markup    | Astro layout `<head>`                                                                |
| `wp_footer` for static theme markup  | Astro layout near the end of `<body>`                                                |
| Dynamic validated metadata           | Plugin `page:metadata` hook                                                          |
| Raw injected markup or scripts       | Trusted native `page:fragments`; unavailable to registry-installed sandboxed plugins |
| `the_content` presentation           | Portable Text components or ordinary Astro rendering                                 |
| `pre_get_posts`                      | Explicit content-query filters in the owning route                                   |
| `save_post`                          | Plugin content lifecycle hook                                                        |
| REST endpoint                        | Plugin route, private by default with an explicit permission                         |
| Scheduled event                      | Plugin `cron` hook and `ctx.cron` scheduling                                         |
| Remote service call                  | Plugin `ctx.http.fetch()` with declared network access                               |
| Publication filter or status change  | Publication policy hook or revision-fenced content action                            |
| Editor metabox or saved-entry action | Sandboxed editor panel/action or trusted React extension                             |

Use a sandboxed plugin by default. A trusted native plugin is warranted only for host-process access, React admin code, Astro render components, raw page fragments, or custom Portable Text block definitions.

## Assets and frontend scripts

- Import theme CSS from the Astro layout or owning component.
- Convert small WordPress scripts to scoped client scripts or framework components only when the interaction remains necessary.
- Use Astro's asset handling for theme-owned static assets.
- Use the EmDash `Image` component for CMS image fields.
- Preserve responsive, focus, reduced-motion, and keyboard behavior from the source when they are part of the design.

Do not assume demo images, fonts, or icons share the theme code's license. Track their rights separately.

## Reusable content and widgets

| WordPress concept                                     | EmDash destination                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Reusable block or synced pattern                      | Section when editors should insert reusable Portable Text content                     |
| Text or Custom HTML widget                            | Content widget when Portable Text is sufficient                                       |
| Navigation Menu widget                                | Menu widget                                                                           |
| Search, category, tag, recent-post, or archive widget | Verify the current core widget component and settings in the canonical seed reference |
| Theme-specific widget with fixed presentation         | Astro component                                                                       |
| Theme-specific editor-managed widget                  | Registered component or a plugin-owned admin experience                               |

Avoid claiming a one-to-one widget mapping until the current component and its settings are verified.

## Migration questions

Resolve these before implementation when they affect the result:

- Which WordPress page types and responsive states are in scope?
- Which behavior comes from the theme, and which comes from plugins?
- Which Customizer values must remain editor-controlled?
- Are menu locations and widget areas editor-managed in the target site?
- How do legacy URLs map to the new routes?
- Which reusable blocks, shortcodes, and widgets need content migration?
- Which source assets may legally be redistributed?
- Does an existing production site need an importer rather than a seed?
