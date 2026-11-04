This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
pnpm dev              # Start the Astro dev server
npx emdash types      # Regenerate TypeScript types from a running site
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

## Key Files

| File                     | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `astro.config.mjs`       | Astro config with `emdash()` integration, database, and storage                    |
| `src/live.config.ts`     | EmDash loader registration (boilerplate -- don't modify)                           |
| `seed/seed.json`         | Schema definition + demo content (collections, fields, taxonomies, menus, widgets) |
| `emdash-env.d.ts`        | Generated types for collections (auto-regenerated on dev server start)             |
| `src/layouts/Base.astro` | Base layout with EmDash wiring (menus, search, page contributions)                 |
| `src/pages/`             | Astro pages -- all server-rendered                                                 |

## Skills

Agent skills are in `.agents/skills/`. Load them when working on specific tasks:

- **building-emdash-site** -- Querying content, rendering Portable Text, schema design, seed files, site features (menus, widgets, search, SEO, comments, bylines). Start here.
- **creating-plugins** -- Building EmDash plugins with hooks, storage, admin UI, API routes, and Portable Text block types.
- **emdash-cli** -- CLI commands for content management, seeding, type generation, and visual editing flow.

## Documentation

The EmDash docs are available as an MCP server at `https://docs.emdashcms.com/mcp`. When you need to verify an API, hook, config option, field type, or pattern, call `search_docs` against the live documentation rather than relying on training-data recall. The docs reflect current behaviour; assumptions may not.

This template ships with `.mcp.json`, `.cursor/mcp.json`, and `.vscode/mcp.json` so Claude Code, Cursor, and VS Code auto-discover the docs server. Other tools (OpenCode, Windsurf, etc.) need a manual one-time setup -- see [docs.emdashcms.com/docs-mcp](https://docs.emdashcms.com/docs-mcp).

## Rules

- All content pages must be server-rendered (`output: "server"`). No `getStaticPaths()` for CMS content.
- Image fields are objects (`{ src, alt }`), not strings. Use `<Image image={...} />` from `"emdash/ui"`.
- `entry.id` is the slug (for URLs). `entry.data.id` is the database ULID (for API calls like `getEntryTerms`).
- When Astro's cache is enabled, pass content-query hints to `Astro.cache.set(cacheHint)`. Use the `WithCacheHint` variants for site settings, menus, taxonomies, and widget areas rendered by cached routes.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).

## This Template

A blog with posts, pages, categories, tags, full-text search, and RSS. Designed for personal writing, technical writing, indie newsletters, and anything where the writing is the product. Neutral editorial aesthetic: a framed layout with hairline rails, white cards on an off-white canvas, Inter with JetBrains Mono labels, and real article structure with bylines and reading time.

## Pages

| Page        | Path               | What it shows                                                                                                                  |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Home        | `/`                | Site title and tagline, featured post card (first post with an image), latest posts grid                                       |
| All posts   | `/posts`           | Post rows with thumbnails, excerpts, bylines, and tag chips; cursor pagination                                                 |
| Post detail | `/posts/[slug]`    | Tags, title, excerpt, featured image, then a three-column reading view: meta rail, body, table of contents and sidebar widgets |
| Search      | `/search`          | Full-text search over posts; matching title terms are highlighted                                                              |
| Page        | `/pages/[slug]`    | Static page content (Portable Text)                                                                                            |
| Category    | `/category/[slug]` | Card grid of posts in a category                                                                                               |
| Tag         | `/tag/[slug]`      | Card grid of posts with a tag                                                                                                  |
| RSS         | `/rss.xml`         | Generated feed                                                                                                                 |

## Schema

- `posts` collection: `title`, `featured_image`, `content` (Portable Text), `excerpt` (text).
- `pages` collection: `title`, `content` (Portable Text). Used for `/about` etc.
- Taxonomies: `category`, `tag`.
- Single `primary` menu (Home, About, Posts by default).

Site settings have `title` and `tagline`. The title renders in the header, the home page intro, and the footer; the tagline renders under the title in the home page intro and in the footer.

## Visual character

The palette is neutral: an off-white canvas (`--color-bg`), white surfaces (`--color-surface`), and near-black ink. `--color-brand` is ink too -- it drives buttons, links, focus rings, and the site monogram. Dark mode inverts the same scale.

Every page sits in a frame: two hairline rails run the full height of the page, and each full-width section (`.band`) is ruled off with a hairline that meets the rails at a small crosshair. Cards are white with a 1px ring and a soft shadow, and their images are inset so the corners stay concentric (`--radius-xl` card = `--radius-lg` image + `--card-padding`).

Type is **Inter** on `--font-body` for everything, with weight and size carrying the hierarchy. **JetBrains Mono** on `--font-mono` sets code and the small uppercase labels (`.eyebrow`) used for section names and meta. Page titles use `--font-size-display` with tight tracking; the home intro pairs the site title with the tagline as a muted second line.

The article layout is the standout feature: a meta rail (authors, date, reading time), a 680px body column, and a rail with the table of contents and sidebar widgets. Below 1100px it collapses to one column, the table of contents is hidden, and the widgets move under the article. Don't flatten it on desktop -- the layout signals "this is something to read".

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css` or `Base.astro` for visual changes.

Colours are defined with `light-dark(<light>, <dark>)`, so each token carries both modes. Overriding with a plain colour changes light and dark at once; use `light-dark()` in the override to keep them distinct. There is no separate dark palette to maintain. To give the site a colour, set `--color-brand`, `--color-brand-hover`, and `--color-on-brand` together: `--color-on-brand` defaults to near-black in dark mode, to sit on the light ink brand.

Webfonts are configured in `astro.config.mjs` under `fonts:`. To swap the body face, change the `name:` for the entry bound to `cssVariable: "--font-body"`. Good alternatives: Geist, IBM Plex Sans, Söhne (if you have a licence), Public Sans. If you want a serif-bodied blog, swap to a humanist serif like Source Serif, Crimson Pro, or Lora -- but then also raise `--font-size-base` to `1.0625rem` for readability. To give headings their own face (or use a system font) without touching the font pipeline, override `--font-heading` or `--font-body` in `theme.css`.

`Base.astro` defines the shared building blocks every page uses: `.frame` (content width, aligned with the rails), `.band` and `.section` (full-width sections), `.intro`, `.eyebrow`, `.chip`, `.btn`, and `.post-grid`. Posts render through `src/components/PostCard.astro` (`card`, `feature`, and `row` variants) and bylines through `src/components/Byline.astro`.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--color-brand`, `--color-brand-hover`, `--color-on-brand`, `--color-brand-ring`
- `--color-bg`, `--color-surface`, `--color-fill`, `--color-text`, `--color-text-secondary`, `--color-muted`, `--color-border`, `--color-ring`
- `--font-body`, `--font-heading`, `--font-mono`
- `--font-weight-heading` / `--font-weight-display` (both 600) -- heading weights; lower them if you switch to a serif
- `--font-size-display` -- page titles
- `--radius-sm` / `--radius` / `--radius-lg` / `--radius-xl` / `--radius-full`, `--card-padding`
- `--shadow-card`, `--shadow-card-hover`
- `--content-width` (680px) -- article body column
- `--wide-width` (1200px) -- the frame, rails included
- `--frame-margin` / `--frame-padding` -- space outside and inside the rails
- `--meta-col-width` (180px) / `--gutter-width` (200px) -- the article rails
- `--avatar-size-{xs,sm,md,lg}` -- byline avatar sizes

## What not to do

- Don't add a second accent colour or coloured section backgrounds. If the site needs a colour, it goes in `--color-brand`.
- Don't replace Inter with a display sans (Bebas, Anton, etc.). Headings rely on weight and size, not novelty faces.
- Don't break the frame: new sections should be `.band` elements with their content in a `.frame`, so the rails and rules line up.
- Don't collapse the article rails on desktop -- they're part of the reading experience.
- Don't use stock blog copy ("Welcome to my blog", "Stay tuned for more"). Write a real tagline that says what this blog is about.
- Don't seed the home page with three identical placeholder posts. If you only have one real post, show one real post.
- Comments are enabled on posts and rendered on the post detail page. Configure moderation before publishing the site, or remove `commentsEnabled` and the comments UI together.
