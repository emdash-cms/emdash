## This Template

A SaaS-style marketing template with modular landing-page blocks, an editorial blog, and a contact page. It is designed for product marketing sites and app landing pages that need a complete marketing and publishing flow.

More structured than the blog and portfolio templates: navy-tinted surfaces, a focused blue accent, an isometric hero illustration, and restrained 700-weight display type. The voice is direct and product-confident without tipping into stock SaaS cliche.

## Pages

| Page             | Path           | What it shows                                                                                                                                    |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home             | `/`            | Marketing blocks in any order (hero, features, testimonials, pricing, FAQ, call to action) authored as a Portable Text document on the Home page |
| Blog             | `/blog`        | One featured post and a responsive grid of the remaining published posts                                                                         |
| Blog post        | `/blog/[slug]` | Post title, author, cover, metadata, and Portable Text article content                                                                           |
| Contact          | `/contact`     | Left column with contact methods (Email / Support / Sales, each with a blue icon), right column with a form                                      |
| Pricing redirect | `/pricing`     | Redirects to the pricing section at `/#pricing`                                                                                                  |

## Contact form

The seeded contact form validates required fields and reports a local success state. Connect the submission to an email or webhook service, and add CSRF protection and rate limiting before using it in production.

## Schema

- `pages` collection: `title`, `content` (Portable Text containing marketing blocks).
- `posts` collection: `title`, `excerpt`, `category`, `featured`, `featured_image`, `cover_style`, `content`.
- No taxonomies.
- Four menus: `primary`, `footer_product`, `footer_company`, `footer_support`.

Site settings have `title` and `tagline`. Title renders in the header; tagline is used in the footer / metadata.

Blog posts use `featured_image` when an editor selects an image. Without an image, `BlogCover.astro` renders the `cover_style` value (`signal`, `blueprint`, or `orbit`). The seed includes three author bylines and one post for each cover style.

## Marketing blocks

This template ships a local plugin at `src/plugins/marketing-blocks/` that registers six Portable Text block types. Editors insert them in the admin's Portable Text editor; they render via `src/components/blocks/{Hero,Features,Testimonials,Pricing,FAQ,CallToAction}.astro` (dispatched from `MarketingBlocks.astro`).

| Block                    | Fields                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketing.hero`         | `headline`, `subheadline`, `primaryCtaLabel`, `primaryCtaUrl`, `secondaryCtaLabel`, `secondaryCtaUrl`, `centered` (toggle)                        |
| `marketing.features`     | `headline`, `subheadline`, repeater of `{ icon, title, description }`                                                                             |
| `marketing.testimonials` | `headline`, repeater of `{ quote, author, role, company, avatar (URL) }`                                                                          |
| `marketing.pricing`      | `headline`, `subheadline`, repeater of `{ name, price, period, description, features (newline-separated string), ctaLabel, ctaUrl, highlighted }` |
| `marketing.faq`          | `headline`, repeater of `{ question, answer }`                                                                                                    |
| `marketing.cta`          | `mutedHeadline`, `headline`, `body`, `primaryCtaLabel`, `primaryCtaUrl`, `secondaryCtaLabel`, `secondaryCtaUrl`                                   |

Constraints worth remembering:

- Block Kit has no nested object element, so a CTA's `{ label, url }` is flattened to sibling fields like `primaryCtaLabel` + `primaryCtaUrl`. The renderer reads the flat keys -- don't try to nest them.
- Repeater sub-fields are scalar only. Lists-of-strings (e.g. pricing features) are a single multiline text field, split on newline at render time.
- There is no media-picker element in the plugin block modal yet, so where image fields exist they are URL strings entered by hand (testimonial `avatar`). Use real URLs, not placeholders.
- The `marketing.hero` block has no image field in the editor schema. The hero renderer falls back to the bundled `/hero-visual.svg` illustration when no image is set. To customise the hero artwork, swap `/hero-visual.svg` in `public/` or extend the plugin schema with an image field (and update `Hero.astro` accordingly).
- Icons in the Features block come from a fixed set: `zap, shield, users, chart, code, globe, heart, star, check, lock, clock, cloud`. Pick from that list.

## Visual character

Typography is **Inter** on `--font-body` with weights from 400 through 800. Hero, section, and default headings use 700 for a clear but neutral hierarchy. There is no mono font or serif. Headline tracking is tight (`--tracking-tight`).

The component styles use the same token roles as the EmDash public site, with navy-tinted neutrals and one blue accent family:

- `--color-bg: var(--background-base)` (`#f7f9fc` / `#0a0a0a`) -- the light and dark canvas
- `--color-surface: var(--surface)` (`#ffffff` / `#171717`) -- bordered cards and panels
- `--color-primary: var(--heat-100)` (`#0075de` / `#0075de`) -- links, focus, and selected states
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
