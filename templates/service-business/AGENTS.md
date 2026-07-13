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

A reusable website for local service businesses. It combines service and service-area landing pages with project galleries, reviews, FAQs, team details, credentials, and a contact page. The starter content uses a fictional home-services company; replace its claims, contact details, and service area before launch.

## Pages

| Page                | Path                    | What it shows                                                     |
| ------------------- | ----------------------- | ----------------------------------------------------------------- |
| Home                | `/`                     | Hero, featured services and projects, reviews, FAQs, service areas, credentials, CTA |
| Services            | `/services`             | All service summaries                                             |
| Service detail      | `/services/[slug]`      | Service description, pricing note, related FAQs, estimate CTA     |
| Projects            | `/projects`             | Project gallery index                                             |
| Project detail      | `/projects/[slug]`      | Project summary, result, and image gallery                         |
| Service-area detail | `/service-areas/[slug]` | Local landing page and available services                         |
| About               | `/about`                | Company story, team, certificates, and partners                   |
| Contact             | `/contact`              | Contact details, service areas, and a mail-client estimate form   |

There is no `/work` route. Project URLs live under `/projects`.

## Schema

- `business_settings`: global business identity, contact information, address, hours, hero copy, and primary CTA.
- `services`: title, short description, Portable Text description, icon, pricing note, and featured toggle.
- `projects`: title, service, location, summary, gallery, and result.
- `reviews`: customer name, quote, rating, service, and location.
- `faqs`: question, answer, and optional service category.
- `service_areas`: name, region, and description.
- `team`: name, role, bio, and years of experience.
- `certificates`: certificate or partner name, issuer, credential, and short logo text.
- `service_category` taxonomy applies to services and projects.
- A single `primary` menu drives the header and footer navigation.

The `gallery` field on `projects` is a repeater whose items have required scalar `src` and `alt` fields. Render it as an array of `{ src: string, alt: string }`; do not treat it as an EmDash image field. The starter uses external image URLs, so replace them with durable URLs you control.

The contact form intentionally uses `mailto:` and opens the visitor's email client. Before production, connect it to a form service or server endpoint with validation, spam protection, and delivery monitoring.

## Visual character

The template is confident and neighborly rather than corporate. **Manrope** is the heading face on `--font-heading`; body copy uses the system sans stack on `--font-body`. Headings are sturdy and compact, while copy stays direct and practical.

The palette pairs a deep service green (`--brand`) with a warm gold (`--accent`). Cards use restrained borders, round corners, and a soft shadow. Colour bands mark service areas and calls to action; avoid spreading the accent onto every element.

## Customisation

Default tokens live in `src/styles/tokens.css`. Put brand overrides in `src/styles/theme.css`, which is intentionally empty in the generated starter. Do not edit `Base.astro` just to change colours or type.

Colours use `light-dark(<light>, <dark>)`, so each default token supports both modes. Use `light-dark()` in overrides when the light and dark values should differ.

The heading font is configured in `astro.config.mjs` under `fonts:`. If you replace Manrope, keep a broad weight range so navigation, cards, and large headings remain distinct.

Important tokens include:

- `--ink`, `--muted`, `--bg`, `--surface`, `--border`
- `--brand`, `--brand-strong`, `--accent`, `--on-brand`
- `--font-body`, `--font-heading`
- `--max`, `--radius`, `--shadow`

## What not to do

- Don't publish the fictional business name, phone number, address, credentials, reviews, or service claims as real facts.
- Don't add a service-area page for a place the business does not actually serve.
- Don't remove the visible contact route or make the primary CTA lead to a dead end.
- Don't turn the project gallery into a portfolio-style `/work` section; existing links and seed data use `/projects`.
- Don't change the gallery item shape without updating the seed schema, generated types, and both project renderers together.
- Don't imply the starter's `mailto:` form stores or delivers submissions on the server.
