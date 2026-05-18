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

Typography is the design. The display face is **Playfair Display** (serif) on the `--font-serif` CSS variable; the body face is the system sans stack on `--font-sans`. The serif is used for the site title, hero titles, project titles, page titles, and contact column labels. Everything else is the sans.

The accent colour is barely visible by design -- the only saturated colour on the page should be inside images. The default `--color-accent` (`#7c3aed`) is used sparingly for link hover and focus states.

Whitespace is generous. Sections breathe. Don't fight that.

## Customisation

`src/styles/theme.css` is the only file to edit for visual changes. Every CSS variable from `Base.astro` is listed there as a commented default -- uncomment and change to override. The dark mode palette is defined inside `Base.astro` itself; light-mode overrides in `theme.css` won't affect dark mode. To customise dark mode, add `@media (prefers-color-scheme: dark)` and `:root.dark` rules in `theme.css`.

Fonts are configured in `astro.config.mjs` under `fonts:` (the Astro Fonts API). To change the display face, swap the `name:` for any Google Fonts serif and keep `cssVariable: "--font-serif"`. Good pairings: Cormorant Garamond, Fraunces, EB Garamond, DM Serif Display. Avoid changing the body font unless you have a reason -- system sans is deliberately quiet here.

CSS variables worth knowing:

- `--color-accent` / `--color-accent-muted` -- the single accent, used very sparingly
- `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-border` -- neutral palette
- `--font-serif`, `--font-sans` -- bound to the Fonts API entries in `astro.config.mjs`
- `--font-size-4xl` -- the size of the homepage title and project titles
- `--max-width` (720px), `--wide-width` (1200px) -- column widths

## What not to do

- Don't introduce gradients, drop shadows on cards, or coloured section backgrounds. The template's voice is calm and editorial; those break it.
- Don't change `--font-sans` to a display font. Two display faces fight each other.
- Don't add more than one accent colour.
- Don't write generic copy like "Welcome to my portfolio" or "Crafting beautiful experiences". The work should speak; the words should be specific (a client name, a discipline, a year).
- Don't pack the home page with every project. The "Selected Work" framing is intentional -- 3-6 is plenty.
- Don't add a `gallery` of small thumbnails on the home page. Use one strong image per project; the gallery field renders on the project detail page only.
