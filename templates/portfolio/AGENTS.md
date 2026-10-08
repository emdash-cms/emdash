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

| Page           | Path           | What it shows                                                                                                                                                                 |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home           | `/`            | The Layout blocks of the Pages entry `home`; by default a large statement, a "Selected work" grid, and a line of clients                                                      |
| Work index     | `/work`        | A numbered list of every project (number, project, client, discipline, year), a discipline filter, and 12 projects per page                                                   |
| Project detail | `/work/[slug]` | Title, summary, a facts list (client, year, disciplines, website), cover image, Portable Text body, gallery, and a link to the next older project                             |
| About          | `/about`       | The Pages entry `about`: its title and Portable Text content; the first paragraph is set as a lead, headings hang in the left column, and images run full width               |
| Contact        | `/contact`     | The Pages entry `contact`: a Contact details block with a heading, an introduction, a large email link and studio details, followed by the social profiles from site settings |
| Other pages    | `/[slug]`      | Any other Pages entry, laid out like About or Contact (see "How pages render")                                                                                                |

On wide screens with a mouse or trackpad, hovering or focusing a row on `/work` shows that project's cover image beside the list. On touch screens and windows narrower than 1280px, each row shows a thumbnail instead.

## Schema

- `projects` collection: `title`, `featured_image` (labelled "Cover image"), `summary` (text, up to 200 characters), `client`, `year`, `url` (labelled "Website", starting with `http://` or `https://`), `featured` (boolean labelled "Feature on home page", synced across translations), `content` (Portable Text), `gallery` (repeater of a required media-library image and an optional one-line caption). The admin's Projects list shows the Client, Year and Feature on home page columns.
- `pages` collection: `title`, `content` (Portable Text), `layout` (blocks). Every page renders both `content` and `layout`; see "Pages".
- Taxonomy: `tag`, labelled "Disciplines" in the admin and used as the project's disciplines. Entries from `getEmDashCollection` and `getEmDashEntry` already carry their terms at `entry.data.terms.tag`, so pages read disciplines from there without another query.
- Two menus. `primary` holds the header navigation, which the footer's Index column repeats. `footer` is the footer's call to action: the menu's name is the heading, its items are the links, and with no items the call to action is hidden. It's also hidden on the pages its links point to, so the seeded "Start a conversation" link doesn't show on `/contact`.

Projects are ordered newest first by publication date on `/work`, in Selected work, for the next-project link and in the RSS feed. To place an older project correctly, set its publication date in the project editor's Publish panel.

Selected work shows the featured projects, newest first, up to 12, or the six newest when no project is featured. Editors feature a project with the **Feature on home page** switch in the project editor. The field defaults to off, so once any project is featured, a project created through the API or MCP appears there only when its data sets `featured: true`.

Site settings drive the identity:

- `title` -- the header wordmark, the footer wordmark (sized to fill the page width), and the copyright line.
- `tagline` -- the footer text, the default meta description, and the home page statement when there is no `home` entry or its Layout is empty. The seeded `home` entry stores its own statement, label and client names, so they don't follow changes to the tagline or to projects.
- `logo` -- replaces the title in the header when set.
- Social profiles (Settings → Social Links) -- the footer's "Follow" links and the "Elsewhere" list in the Contact details block. Settings store handles or URLs, and `src/utils/social.ts` turns handles into profile URLs.

Render `gallery` images with `<Image>` from `emdash/ui`; do not reduce media values to raw URLs.

The contact page sends visitors to their email app instead of accepting a form submission. The email address and studio details are fields of the Contact details block on the `contact` page, so editors replace the sample values in the admin before publishing the site.

## How pages render

`src/pages/[slug].astro` renders every Pages entry at `/{slug}`, the collection's URL pattern, so a page an editor creates works without code and a renamed page keeps working at its new URL. `src/components/PageView.astro` lays the page out:

- When its Layout starts with a Statement or Contact details block, that block is the page heading. The title isn't shown, the blocks come first, and the Content follows them.
- Otherwise the page shows its title as the heading, then its Content, then its Layout blocks. A page with neither says "Content coming soon."

When a page's SEO panel is empty, its meta description comes from the opening Statement or Contact details block, then from the tagline.

The seeded menu links to `/about` and `/contact`. While the primary menu links to one of them and its entry doesn't exist, as on a site set up without sample content, the route shows a placeholder titled About or Contact, marked `noindex`, instead of a 404. Signed-in users also see a note, visible only to them, that points to Pages. The home page shows the same kind of note while it renders its default sections.

Keep the slug `home` on the home page entry: `/` loads the entry by that slug. Routes in `src/pages/` take precedence over `[slug].astro`, so a page with the slug `work` is hidden behind the work index. Slugs the admin creates never contain dots, so `[slug].astro` sends dotted paths such as `/favicon.ico` to the 404 page without looking them up.

A site set up from an older version of this template has no `layout` field on Pages, no block types, no `contact` entry and no `footer` menu. Its pages render their title and Content, and `/contact` shows the placeholder until the block types and the Layout field are added as in step 2 of "To add a page section", and a `contact` page with a Contact details block is published. The footer shows no call to action until a menu named `footer` exists.

## Page blocks

A page's `layout` field is a blocks field, so editors add, reorder, duplicate, remove, and edit its sections in the admin. The seed defines four block types in the "Portfolio" category. The `home` entry has a Statement, a Selected work and a Clients block, in that order, and the `contact` entry has a Contact details block:

| Block type                | Fields                                                                                                                                                                    | What it renders                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `portfolio_statement`     | `text` (up to 160 characters), `label` (optional)                                                                                                                         | The large statement, keeping its line breaks, with `label` as the small label beside it. The statement is the page's `h1` when the block comes first and an `h2` anywhere else; on the home page, when another kind of block comes first, the page adds a visually hidden `h1` with the site title |
| `portfolio_selected_work` | `heading` (default "Selected work")                                                                                                                                       | The heading and project count, a "Full index" link to `/work`, and the project grid; a "No projects yet" message when there are no projects                                                                                                                                                        |
| `portfolio_clients`       | `heading` (default "Clients"), `clients` (repeater of `name`, 1 to 40 rows)                                                                                               | The client names in a row, separated by slashes                                                                                                                                                                                                                                                    |
| `portfolio_contact`       | `heading`, `label` (optional), `intro` (optional), `email`, `email_label` (default "Email"), `details` (repeater of `label`, `text` and an optional `note`, up to 6 rows) | The heading, which is the page's `h1` when the block comes first, the introduction, and the email address as a large link. Below them, a row of details: the email address under `email_label` (left out when that's empty), each detail, and the social profiles under "Elsewhere"                |

`src/components/PageBlocks.astro` maps each type in the generated `PageLayoutBlock` union to a component in `src/components/blocks/` (`Statement.astro`, `SelectedWork.astro`, `Clients.astro`, `Contact.astro`) with `defineBlockComponents()`. A component receives the stored block as `value`, plus `index` and `blockKey`. Selected work loads its own projects with `getSelectedWork()` from `src/utils/selected-work.ts`; EmDash caches those queries for the request, so the page and the block share one result.

Keep the wrappers around the blocks: `.home-layout` in `src/pages/index.astro` and `.page-blocks` in `src/components/PageView.astro`. They space the sections, and in edit mode their `{...entry.edit.layout}` attributes open the Layout field in the admin when an editor clicks a section. The `home` entry's SEO panel sets the home page title and meta description; when it is empty, the site title and tagline apply. Text in the `home` entry's Content field appears below its blocks.

Without a published `home` entry (a site set up without sample content, or the entry deleted or unpublished), or when its Layout is empty, `index.astro` builds the same three blocks in code: the tagline as the statement, labelled with the years of the selected projects, then Selected work, then the selected projects' clients when there are at least two. With the seeded settings and projects, both versions render the same page.

The Pages collection's `/{slug}` URL pattern gives the `home` entry the URL `/home`. `src/pages/home.astro` redirects it to `/` and keeps the query string, so the entry's preview links work.

To add a page section, add a block type:

1. Add its definition to `blockTypes` in `seed/seed.json` and its slug to the `layout` field's `validation.allowedTypes`. New sites get both at setup.
2. Add it to your database. Editing the seed doesn't change a site that is already set up, so create the block type through the schema API or MCP (`schema_create_block_type`), then allow it on the Layout field in the admin (**Content Types** → Pages) or through the same API. The dev server then regenerates `emdash-env.d.ts` with the new type in `PageLayoutBlock`; `npx emdash types` does the same.
3. Add a component in `src/components/blocks/`. The existing components show the `BlockComponentProps` typing. Don't give its outer element a block margin: the `.home-layout` and `.page-blocks` wrappers space every section the same way, whatever the order.
4. Map the type to the component in `PageBlocks.astro`. `defineBlockComponents()` reports a type error until every type in `PageLayoutBlock` has a component.

On a deployed site, deploy the component before you create and allow the block type there. A block without a component renders a placeholder in development and nothing in production.

A block type's field rules, including the character limits, are part of its version. Loosening a rule later is compatible with stored blocks; tightening one needs a new version.

Block definitions can't contain reference fields, so Selected work picks projects by their `featured` flag instead of storing a list of projects.

## Text in code

Some text belongs to the template rather than the content, so it is written in the Astro files instead of the admin: the footer's column labels, the `/work` heading and introduction, the labels in a project's facts list, "Full index", "Elsewhere", the empty states, and the 404 page. Change them in `src/`.

## Visual character

The typeface is **Host Grotesk** on `--font-sans`, used for headings and body text through `--font-heading` and `--font-body`. Labels, numbers, and captions use **Fragment Mono** on `--font-mono` through `--font-label`, set small and uppercase. Weights stay calm on purpose: `--font-weight-heading` and `--font-weight-display` default to 500.

The palette is paper (`--color-bg`) and ink (`--color-text`). The brand colour is ink too, so the only saturated colour on the page should be inside images.

Structure comes from hairline rules, numbering, and a 12-column grid, not from boxes or shadows. Keep the generous whitespace between sections (`--section-gap`).

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
