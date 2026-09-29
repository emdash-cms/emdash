# Phase 3: Convert templates

Convert the in-scope WordPress templates into Astro routes, layouts, and components. Use [concept mapping](../references/concept-mapping.md) for WordPress-to-Astro responsibilities. Read the current [querying and rendering reference](../../building-emdash-site/references/querying-and-rendering.md) before writing EmDash queries; it is the canonical source for result shapes, cache hints, images, Portable Text, pagination, and visual-editing attributes.

## Inventory the source templates

Read the applicable PHP templates and `functions.php`. Record:

- the template hierarchy and fallbacks;
- menu and widget locations;
- custom post types and taxonomies;
- page-template choices;
- conditional layout and body classes;
- shortcodes, blocks, or plugin calls the theme assumes.

Map only the routes the requested site needs. A common mapping is:

| WordPress template                | Astro destination              |
| --------------------------------- | ------------------------------ |
| `front-page.php` or home template | `src/pages/index.astro`        |
| `single.php`                      | `src/pages/posts/[slug].astro` |
| `page.php`                        | `src/pages/pages/[slug].astro` |
| `archive.php`                     | collection archive route       |
| `category.php` or `tag.php`       | taxonomy archive route         |
| `search.php`                      | search route                   |
| `404.php`                         | `src/pages/404.astro`          |
| `header.php` and `footer.php`     | shared layout or components    |

The exact route names follow the target site's URL design, not WordPress filenames.

## Preserve dynamic behavior

Use `getEmDashCollection()` and `getEmDashEntry()` at request time and pass every returned `cacheHint` to `Astro.cache.set()`. Dynamic EmDash content routes remain server-rendered; do not generate them with `getStaticPaths()` or opt them into prerendering.

`entry.id` is the URL slug. `entry.data.id` is the database ID used by APIs such as `getEntryTerms()` and comments. Use the EmDash `Image` component for CMS image fields and `PortableText` for Portable Text content.

For WordPress page-template choices, add a schema field only when editors need to choose the layout. Map the stored value to a fixed set of imported Astro layouts; do not construct component import paths from content.

## Keep presentation separate

Move shared markup into components when the source theme repeats it. Keep CMS queries near the route or server component that owns the data, and pass typed data into presentational components. Recreate behavior that users can observe; do not carry over PHP helpers or WordPress-specific abstractions that no longer serve a purpose.
