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

A portfolio for a design studio or an independent designer, photographer or illustrator. The layout is editorial and Swiss-influenced: warm paper and ink, one grotesk set large, small mono labels, hairline rules, numbered work, and big photography. The demo content is a fictional studio, Norma, in Rotterdam.

The design is intentionally restrained. Don't pile on colour, gradients, or decoration -- the work is the decoration.

## Pages

| Page           | Path           | What it shows                                                                                                                   |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Home           | `/`            | The Layout blocks of the Pages entry `home`; by default a large statement, a "Selected work" grid, and a line of clients        |
| Work index     | `/work`        | A numbered list of every project (number, project, client, discipline, year), a discipline filter, and 12 projects per page     |
| Project detail | `/work/[slug]` | Title, summary, a facts list (client, year, disciplines, website), cover image, Portable Text body, gallery, and a next project |
| About          | `/about`       | Page title and Portable Text content; the first paragraph is set as a lead and each `h2` section hangs in the left column       |
| Contact        | `/contact`     | A large email link, studio details, and the social profiles from site settings                                                  |

Without a published `home` entry, or when its Layout is empty, `/` renders the same default sections from site settings and projects. `/home` redirects to `/`.

On wide screens with a mouse or trackpad, hovering or focusing a row on `/work` shows that project's featured image beside the list. On touch screens and windows narrower than 1280px, each row shows a thumbnail instead.

## Schema

- `projects` collection: `title`, `featured_image`, `client`, `year`, `summary` (text), `content` (Portable Text), `gallery` (repeater of media-library image + optional caption), `url`, `featured` (boolean labelled "Feature on home page").
- `pages` collection: `title`, `content` (Portable Text), `layout` (blocks). `/about` renders the `about` entry's `content`, and `/` renders the `home` entry's `layout`.
- Taxonomy: `tag`, used as the project's disciplines. Entries from `getEmDashCollection` and `getEmDashEntry` already carry their terms at `entry.data.terms.tag`, so pages read disciplines from there without another query.
- Single `primary` menu.

Selected work on the home page shows the featured projects, newest first, up to 12. When no project is featured, it shows the six newest. Editors feature a project with the **Feature on home page** switch in the project editor. The field defaults to off: once any project is featured, a project created through the API or MCP appears there only when its data sets `featured: true`.

Site settings drive the identity:

- `title` -- the header wordmark, the footer wordmark (sized to fill the page width), and the copyright line.
- `tagline` -- the footer text and the default meta description. It is also the home page statement when there is no `home` entry. The seeded `home` entry stores its own statement, label and client names, so they don't follow changes to the tagline or to projects.
- `logo` -- replaces the title in the header when set.
- Social profiles (Settings → Social) -- the footer's "Follow" links and the contact page's "Elsewhere" list. Settings store handles, and `src/utils/social.ts` turns them into profile URLs.

The `gallery` field is a repeater. Each row contains a required `image` selected from the EmDash media library and an optional `caption`. Render gallery images with `<Image>` from `emdash/ui`; do not reduce media values to raw URLs.

The contact page sends visitors to their email app instead of accepting a form submission. Replace the example address and the studio details in `src/pages/contact.astro` before publishing the site.

## Home page blocks

The home page renders the Pages entry `home`. Its `layout` field is a blocks field, so editors add, reorder, duplicate, remove, and edit the home page sections in the admin. The seed defines three block types in the "Portfolio" category and gives the `home` entry one of each, in this order:

| Block type                | Fields                                                  | What it renders                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `portfolio_statement`     | `label` (optional), `text`                              | The large statement, keeping its line breaks, with `label` as the small label beside it. The statement is the page's `h1` when the block comes first and an `h2` anywhere else; when another block comes first, the page adds a visually hidden `h1` with the site title |
| `portfolio_selected_work` | `heading`                                               | The heading and project count, a "Full index" link to `/work`, and the project grid; a "No projects yet" message when there are no projects                                                                                                                              |
| `portfolio_clients`       | `heading`, `clients` (repeater of `name`, 1 to 40 rows) | The client names in a row, separated by slashes                                                                                                                                                                                                                          |

`src/components/HomeBlocks.astro` maps each type in the generated `PageLayoutBlock` union to a component in `src/components/blocks/` (`Statement.astro`, `SelectedWork.astro`, `Clients.astro`) with `defineBlockComponents()`. A component receives the stored block as `value`, plus `index` and `blockKey`. Selected work loads its own projects with `getSelectedWork()` from `src/utils/selected-work.ts`. EmDash caches those queries for the request, so the page and the block share one result.

Keep the `.home-layout` wrapper around the blocks in `src/pages/index.astro`. It spaces the sections, and in edit mode its `{...home?.edit.layout}` attributes open the Layout field in the admin when an editor clicks a home page section. The `home` entry's SEO panel sets the home page title and meta description; when it is empty, the site title and tagline apply.

Without a published `home` entry (a site set up without sample content, or the entry deleted or unpublished), or when its Layout is empty, `index.astro` builds the same three blocks in code: the tagline as the statement, labelled with the years of the selected projects, then Selected work, then the selected projects' clients when there are at least two. With the seeded settings and projects, both versions render the same page.

The Pages collection's `/{slug}` URL pattern gives the `home` entry the URL `/home`. `src/pages/home.astro` redirects it to `/` and keeps the query string, so the entry's preview links work.

To add a home page section, add a block type:

1. Add its definition to `blockTypes` in `seed/seed.json` and its slug to the `layout` field's `validation.allowedTypes`. New sites get both at setup.
2. Add it to your database. The seed applies only at first setup, so create the block type through the schema API or MCP (`schema_create_block_type`), then allow it on the Layout field, in the admin under **Content Types** → Pages or through the same API. The dev server then regenerates `emdash-env.d.ts` with the new type in `PageLayoutBlock`; `npx emdash types` does the same.
3. Add a component in `src/components/blocks/`. The existing components show the `BlockComponentProps` typing. Don't give its outer element a block margin: the `.home-layout` wrapper in `index.astro` spaces every section the same way, whatever the order.
4. Map the type to the component in `HomeBlocks.astro`. `defineBlockComponents()` reports a type error until every type in `PageLayoutBlock` has a component.

On a deployed site, deploy the component before you create and allow the block type there. A block without a component renders a placeholder in development and nothing in production.

Block definitions can't contain reference fields, so Selected work picks projects by their `featured` flag instead of storing a list of projects.

## Visual character

The typeface is **Host Grotesk** on `--font-sans`, used for headings and body text through `--font-heading` and `--font-body`. Labels, numbers, and captions use **Fragment Mono** on `--font-mono` through `--font-label`, set small and uppercase. Weights stay calm on purpose: `--font-weight-heading` and `--font-weight-display` default to 500.

The palette is paper (`--color-bg`) and ink (`--color-text`). The brand colour is ink too, so the only saturated colour on the page should be inside images.

Structure comes from hairline rules, numbering, and a 12-column grid, not from boxes or shadows. Whitespace is generous. Sections breathe. Don't fight that.

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css` or `Base.astro` for visual changes.

Colours are defined with `light-dark(<light>, <dark>)`, so each token carries both modes. Overriding with a plain colour changes light and dark at once; use `light-dark()` in the override to keep them distinct. There is no separate dark palette to maintain.

Fonts are configured in `astro.config.mjs` under `fonts:` (the Astro Fonts API). To change a face, swap the `name:` of the `--font-sans` or `--font-mono` entry for another Google Fonts family and keep its `cssVariable`. To use a system font for one role, override `--font-heading`, `--font-body`, or `--font-label` in `theme.css`. If the new face is much wider or narrower than Host Grotesk, adjust `--wordmark-fit` so the footer wordmark still fills the page width.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--color-bg`, `--color-text`, `--color-muted`, `--color-border`, `--color-fill` -- paper, ink, labels, hairlines, and hover fills
- `--color-brand`, `--color-on-brand` -- buttons and focus rings; set `--color-brand` to give the site an accent
- `--font-heading`, `--font-body`, `--font-label` -- the faces for each role
- `--font-size-display` -- the home page statement
- `--font-size-title` -- page and project titles
- `--page-margin`, `--gutter`, `--section-gap`, `--frame-width` -- page margins, grid gaps, section spacing, and the widest the layout grows
- `--measure` -- the longest line of body text
- `--wordmark-fit` -- the average letter width the footer wordmark is sized from

## What not to do

- Don't introduce gradients, drop shadows on cards, or coloured section backgrounds. The template's voice is calm and editorial; those break it.
- Don't add a second display face to fight Host Grotesk. One family at different sizes carries the hierarchy.
- Don't add more than one accent colour.
- Don't write generic copy like "Welcome to my portfolio" or "Crafting beautiful experiences". The work should speak; the words should be specific (a client name, a discipline, a year).
- Don't pack the home page with every project. Feature a few strong ones for "Selected work", which shows at most 12; `/work` lists everything.
- Don't add a `gallery` of small thumbnails on the home page. Use one strong image per project; the gallery field renders on the project detail page only.
- Don't add JavaScript animation or smooth-scrolling libraries. Motion is limited to CSS hover and focus effects, and it turns off for visitors who prefer reduced motion.
