## This Template

A portfolio for showcasing creative work. Editorial, near-monochrome, with photography as the main visual interest. Designed for designers, photographers, illustrators, studios, and other people whose work speaks for itself when laid out with generous whitespace.

The design is intentionally restrained. Don't pile on colour, gradients, or decoration -- the work is the decoration.

## Pages

| Page           | Path           | What it shows                                                                                          |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| Home           | `/`            | Centred serif title + tagline, "Selected Work" grid                                                    |
| Work index     | `/work`        | Heading + summary, tag filter chips, full grid                                                         |
| Project detail | `/work/[slug]` | Project meta line, big serif title, summary, featured image, Portable Text body, optional gallery, URL |
| About          | `/about`       | Page content (Portable Text)                                                                           |
| Contact        | `/contact`     | Form + email / location / social column                                                                |

## Schema

- `projects` collection: `title`, `featured_image`, `client`, `year`, `summary` (text), `content` (Portable Text), `gallery` (json -- optional array of `{ url, alt? }` records, see below), `url`.
- `pages` collection: `title`, `content` (Portable Text). Used for `/about`.
- Taxonomies: `category`, `tag`. Used for filtering on the work index.
- Single `primary` menu.

Site settings have `title` and `tagline` -- both render on the home page (title as the centred serif heading, tagline as italic subtitle).

The `gallery` field on `projects` is a JSON field, not an EmDash image field. It expects a literal array of `{ url: string, alt?: string }` records (a flat external URL plus optional alt text), and is rendered as-is by `src/pages/work/[slug].astro`. Do NOT confuse it with EmDash image fields like `featured_image`, which take `{ id, provider, alt }` objects from the media library. If you need media-library images in a gallery in the future, the right fix is to change the field type and renderer together.

## Visual character

Typography is the design. The display face is **Playfair Display** (serif) on the `--font-heading` CSS variable; the body face is the system sans stack on `--font-body`. The serif is used for the site title, hero titles, project titles, page titles, and contact column labels. Everything else is the sans. Serif weight is calm on purpose (`--font-weight-heading` and `--font-weight-display` both default to 500).

The brand colour is barely visible by design -- the only saturated colour on the page should be inside images. The default `--color-brand` (`#7c3aed`) is used sparingly for link hover and focus states.

Whitespace is generous. Sections breathe. Don't fight that.

## Customisation

Design tokens live in `src/styles/tokens.css` with their default values. To restyle the site, override tokens in `src/styles/theme.css` -- declarations there are unlayered, so they always beat the `@layer base` defaults. Don't edit `tokens.css` or `Base.astro` for visual changes.

Colours are defined with `light-dark(<light>, <dark>)`, so each token carries both modes. Overriding with a plain colour changes light and dark at once; use `light-dark()` in the override to keep them distinct. There is no separate dark palette to maintain.

The display face is configured in `astro.config.mjs` under `fonts:` (the Astro Fonts API). To change it, swap the `name:` for any Google Fonts serif and keep `cssVariable: "--font-heading"`. Good pairings: Cormorant Garamond, Fraunces, EB Garamond, DM Serif Display. The body face (`--font-body`) is a plain token in `tokens.css` -- system sans, deliberately quiet; override it in `theme.css` only if you have a reason.

CSS variables worth knowing (see `tokens.css` for the full list):

- `--color-brand`, `--color-on-brand`, `--color-brand-ring` -- the single accent, used very sparingly
- `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-border` -- neutral palette
- `--color-danger` -- form errors
- `--font-heading` (Fonts API entry in `astro.config.mjs`), `--font-body` (token)
- `--font-weight-heading` / `--font-weight-display` (both 500) -- raise for a heavier serif voice
- `--font-size-4xl` -- the size of the homepage title and project titles
- `--max-width` (720px), `--wide-width` (1200px) -- column widths

## What not to do

- Don't introduce gradients, drop shadows on cards, or coloured section backgrounds. The template's voice is calm and editorial; those break it.
- Don't change `--font-body` to a display font. Two display faces fight each other.
- Don't add more than one accent colour.
- Don't write generic copy like "Welcome to my portfolio" or "Crafting beautiful experiences". The work should speak; the words should be specific (a client name, a discipline, a year).
- Don't pack the home page with every project. The "Selected Work" framing is intentional -- 3-6 is plenty.
- Don't add a `gallery` of small thumbnails on the home page. Use one strong image per project; the gallery field renders on the project detail page only.
