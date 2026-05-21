This is an EmDash site -- a CMS built on Astro with a full admin UI.

## Commands

```bash
npx emdash dev        # Start dev server (runs migrations, seeds, generates types)
npx emdash types      # Regenerate TypeScript types from schema
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
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).

## This Template

The most minimal template. A single `index.astro` page with EmDash wired up and nothing else: no collections, no seed, no styles, no components, no layouts beyond what Astro provides by default.

Start here if you want full control from the beginning -- no schema or design decisions made for you.

## Pages

| Page | Path | What it shows                          |
| ---- | ---- | -------------------------------------- |
| Home | `/`  | A single Astro page with EmDash wiring |

## Schema

None. There are no collections, taxonomies, or menus seeded. You define everything via the admin UI (Schema -> Add collection) or by editing `seed/seed.json` once you create one.

## What to do here

This template is a substrate, not a starting design. The natural first steps are:

1. Decide what content types the site needs (posts? events? products?) and define them in the admin under Schema, or by adding a `seed/seed.json`.
2. Add the pages that render that content (e.g. `src/pages/posts/index.astro`).
3. Add a layout in `src/layouts/` for shared chrome.
4. Add styles -- this template has no `theme.css` and no fonts configured.

If any of that sounds like work you don't want to do, start from `starter`, `blog`, `portfolio`, or `marketing` instead. They make these decisions for you.

## What not to do

- Don't expect this template to render a designed site out of the box. It won't.
- Don't add features here that should live in the EmDash core or in a plugin. This template is meant to stay small.
