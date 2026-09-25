## This Template

A SaaS-style landing page template with modular content blocks: hero, features, testimonials, pricing, FAQ, plus a contact page with direct email calls to action. Designed for product marketing sites, app landing pages, and anything that needs a hero + features + pricing + CTA flow.

Bolder than the blog and portfolio templates: vibrant gradient accents, isometric illustration in the hero, heavy headline weights. The voice is product-confident without tipping into stock SaaS cliche.

## Pages

| Page    | Path       | What it shows                                                                                                       |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Home    | `/`        | Marketing blocks in any order (hero, features, testimonials, pricing, FAQ) authored in the Home page's blocks field |
| Pricing | `/pricing` | The same block editor, with a hero, pricing comparison, and FAQ                                                     |
| Contact | `/contact` | CMS-authored hero followed by direct email contacts for general questions, support, and sales                       |

There is no posts collection. Content is entirely authored as marketing blocks inside `pages`.

## Schema

- `pages` collection: `title`, `content` (a first-class `blocks` field).
- No taxonomies.
- Four menus: `primary`, `footer_product`, `footer_company`, `footer_support`.

Site settings have `title` and `tagline`. Title renders in the header; tagline is used in the footer / metadata.

## Marketing blocks

The seed declares five versioned block types. Editors add, reorder, duplicate, and edit them with the built-in blocks field editor. `MarketingBlocks.astro` maps the generated `PageContentBlock` union to `src/components/blocks/{Hero,Features,Testimonials,Pricing,FAQ}.astro` with `defineBlockComponents()`.

| Block                    | Fields                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `marketing_hero`         | `anchor_id`, `headline`, `subheadline`, flattened primary and secondary CTA label/URL pairs, `image`, `centered`       |
| `marketing_features`     | `anchor_id`, `headline`, `subheadline`, repeater of `{ icon, title, description }`                                     |
| `marketing_testimonials` | `anchor_id`, `headline`, repeater of `{ quote, author, role, company, avatar }` where `avatar` is an image field       |
| `marketing_pricing`      | `anchor_id`, `headline`, repeater of `{ name, price, period, description, features, cta_label, cta_url, highlighted }` |
| `marketing_faq`          | `anchor_id`, `headline`, repeater of `{ question, answer }`                                                            |

Constraints worth remembering:

- Block fields cannot contain nested object groups, so CTA labels and URLs remain sibling fields.
- Repeaters cannot contain nested repeaters. Pricing features therefore remain one multiline text value, split on newline by the renderer.
- Hero and testimonial media are EmDash image fields. Render them with `<Image>` from `emdash/ui`, not a raw URL.
- The Hero block falls back to `/hero-visual.svg` when its image field is empty.
- Every stored block has immutable `_type`, `_version`, and `_key` values. Components receive the generated value as `value` plus `index` and `blockKey`; do not treat blocks as Portable Text nodes.
- Render stored CTA URLs through `sanitizeHref()` even when their field validation rejects unsafe-looking values.
- Icons in the Features block come from a fixed set: `zap, shield, users, chart, code, globe, heart, star, check, lock, clock, cloud`. Pick from that list.

## Visual character

Typography is **Inter** on `--font-body` with weights up to 800 for headline emphasis (`--font-weight-display: 800` on hero and section headlines, `--font-weight-heading: 700` on other headings). There is no mono font, no serif. Headline tracking is tight (`--tracking-tight`).

Colour is the loudest of any template here. The default palette is:

- `--color-brand: #6366f1` (indigo) -- main brand colour, used in buttons and links, with `--color-brand-strong` / `--color-brand-soft` shades
- `--color-accent: #f472b6` (pink) -- the gradient partner to brand
- `--color-success`, `--color-warning`, `--color-danger` -- semantic colours (pricing checkmarks and status accents)

Gradients are part of the look and are tokens themselves: `--gradient-brand` (logo, icon tiles, pricing badge, CTA hover), `--gradient-brand-strong` (CTA resting state), `--gradient-brand-soft` (hero image glow), and `--gradient-headline` (hero headline text fill). They follow the brand/accent colours automatically, so a rebrand usually only needs new `--color-brand-*` / `--color-accent-*` values. Don't strip the gradients entirely -- the template will look generic without them -- but a flat brand can set the `--gradient-*` tokens to solid colours.

Shared utility classes keep the blocks consistent: `.section-header` / `.section-headline` / `.section-subheadline` for centred block intros, and `.icon-tile` for the 48px gradient icon squares. Use them in new blocks rather than restyling per block.

Roundness is generous: `--radius` is 10px, `--radius-lg` 16px, plus a `--radius-full` for pills. Shadows are layered (`--shadow-sm` through `--shadow-xl`).

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css` or `Base.astro` for visual changes.

Colours are defined with `light-dark(<light>, <dark>)`, so each token carries both modes. Overriding with a plain colour changes light and dark at once; use `light-dark()` in the override to keep them distinct. There is no separate dark palette to maintain.

Webfonts are configured in `astro.config.mjs` under `fonts:`. To swap the typeface, change the `name:` for the entry bound to `cssVariable: "--font-body"`. Inter has 5 weights loaded (400-800) for hero impact -- if you swap, ensure the replacement has comparable weight range. Geist, Plus Jakarta Sans, Manrope, and DM Sans all work well as replacements. For a system font, or a separate heading face, override `--font-body` / `--font-heading` in `theme.css`. A softer voice (editorial, luxury) usually also wants `--font-weight-display: 700` or lower.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--color-brand`, `--color-brand-strong`, `--color-brand-soft`, `--color-on-brand`, `--color-brand-ring`
- `--color-accent`, `--color-accent-soft`
- `--gradient-brand`, `--gradient-brand-strong`, `--gradient-brand-soft`, `--gradient-headline`
- `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-border`
- `--color-success`, `--color-warning`, `--color-danger`
- `--font-body`, `--font-heading`, `--font-weight-heading` (700), `--font-weight-display` (800)
- `--font-size-{xs,sm,base,lg,xl,2xl,3xl,4xl,5xl,6xl}` -- type scale up to 4.5rem for the largest hero
- `--radius-sm` (6px), `--radius` (10px), `--radius-lg` (16px), `--radius-full`
- `--shadow-sm`, `--shadow`, `--shadow-lg`, `--shadow-xl`

To re-brand, the highest-leverage moves are:

1. Change `--color-brand` (and its `-strong` / `-soft` shades) and `--color-accent` to the brand pair -- the gradients follow.
2. Update the site title (logo wordmark) and tagline.
3. Choose a Hero image in the media library or replace the fallback illustration.
4. Edit hero `headline` and `subheadline` blocks to specific, concrete copy.

## What not to do

- Don't write stock SaaS copy: "Build products people actually want", "Elevate your workflow", "The all-in-one platform for modern teams". These are placeholder. Write what the product actually does, for whom, with one specific outcome.
- Don't ship more than three pricing tiers. Three is the default for a reason -- more makes choice harder, not easier.
- Don't use icon and stock photo combos that fight each other. Pick illustration _or_ photography, not both.
- Don't enable the gradient on every interactive element. The CTA gradient is the signal; if it's on every button, it stops signalling.
- Don't add a hero block followed immediately by another hero block. One hero, then features / testimonials / pricing / FAQ in some order.
- Don't replace the `marketing_pricing` block with a hand-coded table. The block is the data shape downstream renderers expect.
