## This Template

A SaaS-style landing page template with modular content blocks: hero, features, testimonials, pricing, FAQ, plus a real contact page. Designed for product marketing sites, app landing pages, and anything that needs a hero + features + pricing + CTA flow.

Bolder than the blog and portfolio templates: vibrant gradient accents, isometric illustration in the hero, heavy headline weights. The voice is product-confident without tipping into stock SaaS cliche.

## Pages

| Page    | Path       | What it shows                                                                                                                    |
| ------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Home    | `/`        | Marketing blocks in any order (hero, features, testimonials, pricing, FAQ) authored as a Portable Text document on the Home page |
| Pricing | `/pricing` | Same block-driven editor -- "Simple, transparent pricing" page using the `pricing` block                                         |
| Contact | `/contact` | Left column with contact methods (Email / Support / Sales, each with a gradient icon), right column with a form                  |

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

Typography is **Inter** on `--font-sans` with weights up to 800 for headline emphasis. There is no mono font, no serif. Headline tracking is tight.

Colour is the loudest of any template here. The default palette is:

- `--color-primary: #6366f1` (indigo) -- main brand colour, used in buttons and links
- `--color-accent: #f472b6` (pink) -- paired with primary in gradients (CTA buttons, icon backgrounds)
- `--color-success`, `--color-warning` -- semantic colours for inline icons (pricing checkmarks)

Gradients are part of the look (`--color-primary` -> `--color-accent` on the "Get Started" button, on contact-method icons, on the "Most popular" pricing badge). Don't strip them entirely -- the template will look generic without them. Do swap them for a different pair if the brand calls for it.

Roundness is generous: `--radius` is 10px, `--radius-lg` 16px, plus a `--radius-full` for pills. Shadows are layered (`--shadow-sm` through `--shadow-xl`).

## Customisation

`src/styles/theme.css` is the only file to edit for visual changes. Every CSS variable from `Base.astro` is listed there as a commented default. The dark mode palette is defined inside `Base.astro`; light-mode overrides in `theme.css` won't affect dark mode. To customise dark mode, add `@media (prefers-color-scheme: dark)` and `:root.dark` rules in `theme.css`.

Fonts are configured in `astro.config.mjs` under `fonts:`. To swap the typeface, change the `name:` for the entry bound to `cssVariable: "--font-sans"`. Inter has 5 weights loaded (400-800) for hero impact -- if you swap, ensure the replacement has comparable weight range. Geist, Plus Jakarta Sans, Manrope, and DM Sans all work well as replacements.

CSS variables worth knowing:

- `--color-primary`, `--color-primary-dark`, `--color-primary-light`
- `--color-accent`, `--color-accent-light`
- `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-border`
- `--font-sans`
- `--font-size-{xs,sm,base,lg,xl,2xl,3xl,4xl,5xl,6xl}` -- type scale up to 4.5rem for the largest hero
- `--radius-sm` (6px), `--radius` (10px), `--radius-lg` (16px), `--radius-full`
- `--shadow-sm`, `--shadow`, `--shadow-lg`, `--shadow-xl`

To re-brand, the highest-leverage moves are:

1. Change `--color-primary` and `--color-accent` to the brand pair.
2. Update the site title (logo wordmark) and tagline.
3. Replace the hero illustration URL.
4. Edit hero `headline` and `subheadline` blocks to specific, concrete copy.

## What not to do

- Don't write stock SaaS copy: "Build products people actually want", "Elevate your workflow", "The all-in-one platform for modern teams". These are placeholder. Write what the product actually does, for whom, with one specific outcome.
- Don't ship more than three pricing tiers. Three is the default for a reason -- more makes choice harder, not easier.
- Don't use icon and stock photo combos that fight each other. Pick illustration _or_ photography, not both.
- Don't enable the gradient on every interactive element. The CTA gradient is the signal; if it's on every button, it stops signalling.
- Don't add a hero block followed immediately by another hero block. One hero, then features / testimonials / pricing / FAQ in some order.
- Don't replace the `marketing.pricing` block with a hand-coded table. The block is the data shape downstream renderers expect.
