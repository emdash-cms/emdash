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
- Always call `Astro.cache.set(cacheHint)` on pages that query content.
- Taxonomy names in queries must match the seed's `"name"` field exactly (e.g., `"category"` not `"categories"`).

## This Template

A SaaS-style landing page template with modular content blocks: hero, features, testimonials, pricing, FAQ, plus a real contact page. Designed for product marketing sites, app landing pages, and anything that needs a hero + features + pricing + CTA flow.

More structured than the blog and portfolio templates: navy-tinted surfaces, a focused blue accent, an isometric hero illustration, and restrained 700-weight display type. The voice is direct and product-confident without tipping into stock SaaS cliche.

## Pages

| Page    | Path       | What it shows                                                                                                                    |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Home    | `/`        | Marketing blocks in any order (hero, features, testimonials, pricing, FAQ) authored as a Portable Text document on the Home page |
| Pricing | `/pricing` | Same block-driven editor -- "Simple, transparent pricing" page using the `pricing` block                                         |
| Contact | `/contact` | Left column with contact methods (Email / Support / Sales, each with a blue icon), right column with a form                      |

There is no posts collection. Content is entirely authored as marketing blocks inside `pages`.

## Schema

- `pages` collection: `title`, `content` (Portable Text containing marketing blocks).
- No taxonomies.
- Four menus: `primary`, `footer_product`, `footer_company`, `footer_support`.

Site settings have `title` and `tagline`. Title renders in the header; tagline is used in the footer / metadata.

## Marketing blocks

This template ships a local plugin at `src/plugins/marketing-blocks/` that registers five Portable Text block types. Editors insert them in the admin's Portable Text editor; they render via `src/components/blocks/{Hero,Features,Testimonials,Pricing,FAQ}.astro` (dispatched from `MarketingBlocks.astro`).

| Block                    | Fields                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `marketing.hero`         | `headline`, `subheadline`, `primaryCtaLabel`, `primaryCtaUrl`, `secondaryCtaLabel`, `secondaryCtaUrl`, `centered` (toggle)         |
| `marketing.features`     | `headline`, `subheadline`, repeater of `{ icon, title, description }`                                                              |
| `marketing.testimonials` | `headline`, repeater of `{ quote, author, role, company, avatar (URL) }`                                                           |
| `marketing.pricing`      | `headline`, repeater of `{ name, price, period, description, features (newline-separated string), ctaLabel, ctaUrl, highlighted }` |
| `marketing.faq`          | `headline`, repeater of `{ question, answer }`                                                                                     |

Constraints worth remembering:

- Block Kit has no nested object element, so a CTA's `{ label, url }` is flattened to sibling fields like `primaryCtaLabel` + `primaryCtaUrl`. The renderer reads the flat keys -- don't try to nest them.
- Repeater sub-fields are scalar only. Lists-of-strings (e.g. pricing features) are a single multiline text field, split on newline at render time.
- There is no media-picker element in the plugin block modal yet, so where image fields exist they are URL strings entered by hand (testimonial `avatar`). Use real URLs, not placeholders.
- The `marketing.hero` block has no image field in the editor schema. The hero renderer falls back to the bundled `/hero-visual.svg` illustration when no image is set. To customise the hero artwork, swap `/hero-visual.svg` in `public/` or extend the plugin schema with an image field (and update `Hero.astro` accordingly).
- Icons in the Features block come from a fixed set: `zap, shield, users, chart, code, globe, heart, star, check, lock, clock, cloud`. Pick from that list.

## Visual character

Typography is **Inter** on `--font-body` with weights from 400 through 800. Hero, section, and default headings use 700 for a clear but neutral hierarchy. There is no mono font or serif. Headline tracking is tight (`--tracking-tight`).

The component styles use the same token roles as the EmDash public site, with navy-tinted neutrals and one blue accent family:

- `--color-bg: #f7f9fc` / `#0b1220` -- the light and dark canvas
- `--color-surface: #ffffff` / `#121c2e` -- bordered cards and panels
- `--color-primary: #1d4ed8` / `#60a5fa` -- links, focus, and selected states
- `--heat-{4,8,12,16,20,40,90,100}` -- translucent through solid blue interaction treatments
- `--button-primary-*` and `--button-secondary-*` -- shared button foreground and background roles
- `--color-success`, `--color-warning`, `--color-danger` -- semantic colours (pricing checkmarks, form errors)

Blue is reserved for interactive emphasis, focus, and selected treatment; headings and decorative surfaces stay neutral.

Shared utility classes keep the blocks consistent: `.section-header` / `.section-headline` / `.section-subheadline` for centred block intros, and `.icon-tile` for the 48px blue icon squares. Use them in new blocks rather than restyling per block.

Roundness is generous: `--radius` is 10px, `--radius-lg` 16px, plus a `--radius-full` for pills. Shadows are layered (`--shadow-sm` through `--shadow-xl`).

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css` or `Base.astro` for visual changes.

The base values live on `:root`. Dark values are repeated under `:root.dark` and `@media (prefers-color-scheme: dark)` for explicit and system themes. Update all three declarations when a colour differs by appearance.

Webfonts are configured in `astro.config.mjs` under `fonts:`. To swap the typeface, change the `name:` for the entry bound to `cssVariable: "--font-body"`. Inter has 5 weights loaded (400-800) for hero impact -- if you swap, ensure the replacement has comparable weight range. Geist, Plus Jakarta Sans, Manrope, and DM Sans all work well as replacements. For a system font, or a separate heading face, override `--font-body` / `--font-heading` in `theme.css`. A softer voice (editorial, luxury) usually also wants `--font-weight-display: 700` or lower.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--heat-{4,8,12,16,20,40,90,100}`
- `--color-primary`, `--color-primary-dark`, `--color-primary-light`, `--color-focus`
- `--button-primary-*`, `--button-secondary-*`, `--button-disabled-*`
- `--color-brand`, `--color-brand-strong`, `--color-brand-soft` (public-template compatibility aliases)
- `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-border`
- `--color-success`, `--color-warning`, `--color-danger`
- `--font-body`, `--font-heading`, `--font-weight-heading` (700), `--font-weight-display` (700)
- `--font-size-{xs,sm,base,lg,xl,2xl,3xl,4xl,5xl,6xl}` -- type scale up to 4.5rem
- `--radius-sm` (6px), `--radius` (10px), `--radius-lg` (16px), `--radius-full`
- `--shadow-sm`, `--shadow`, `--shadow-lg`, `--shadow-xl`

To re-brand, the highest-leverage moves are:

1. Change the `--heat-*` scale and `--button-primary-fg` in `theme.css`, checking foreground contrast in both appearances.
2. Update the site title (logo wordmark) and tagline.
3. Replace the hero illustration URL.
4. Edit hero `headline` and `subheadline` blocks to specific, concrete copy.

## What not to do

- Don't write stock SaaS copy: "Build products people actually want", "Elevate your workflow", "The all-in-one platform for modern teams". These are placeholder. Write what the product actually does, for whom, with one specific outcome.
- Don't ship more than three pricing tiers. Three is the default for a reason -- more makes choice harder, not easier.
- Don't use icon and stock photo combos that fight each other. Pick illustration _or_ photography, not both.
- Don't use the blue accent as decoration. It identifies actions, focus, and selected states; if every surface is blue, those signals disappear.
- Don't add a hero block followed immediately by another hero block. One hero, then features / testimonials / pricing / FAQ in some order.
- Don't replace the `marketing.pricing` block with a hand-coded table. The block is the data shape downstream renderers expect.
