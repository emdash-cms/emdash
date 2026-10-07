## This Template

A portfolio for a design studio or an independent designer, photographer or illustrator. The layout is editorial and Swiss-influenced: warm paper and ink, one grotesk set large, small mono labels, hairline rules, numbered work, and big photography. The demo content is a fictional studio, Norma, in Rotterdam.

The design is intentionally restrained. Don't pile on colour, gradients, or decoration -- the work is the decoration.

## Pages

| Page           | Path           | What it shows                                                                                                                   |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Home           | `/`            | The tagline as a large statement, a "Selected work" grid of the six newest projects, and a line of their clients                |
| Work index     | `/work`        | A numbered list of every project (number, project, client, discipline, year), a discipline filter, and 12 projects per page     |
| Project detail | `/work/[slug]` | Title, summary, a facts list (client, year, disciplines, website), cover image, Portable Text body, gallery, and a next project |
| About          | `/about`       | Page title and Portable Text content; the first paragraph is set as a lead and each `h2` section hangs in the left column       |
| Contact        | `/contact`     | A large email link, studio details, and the social profiles from site settings                                                  |

On wide screens with a mouse or trackpad, hovering or focusing a row on `/work` shows that project's featured image beside the list. On touch screens and windows narrower than 1280px, each row shows a thumbnail instead.

## Schema

- `projects` collection: `title`, `featured_image`, `client`, `year`, `summary` (text), `content` (Portable Text), `gallery` (repeater of media-library image + optional caption), `url`.
- `pages` collection: `title`, `content` (Portable Text). Used for `/about`.
- Taxonomy: `tag`, used as the project's disciplines. Entries from `getEmDashCollection` and `getEmDashEntry` already carry their terms at `entry.data.terms.tag`, so pages read disciplines from there without another query.
- Single `primary` menu.

Site settings drive the identity:

- `title` -- the header wordmark, the footer wordmark (sized to fill the page width), and the copyright line.
- `tagline` -- the statement on the home page, the footer, and the default meta description.
- `logo` -- replaces the title in the header when set.
- Social profiles (Settings → Social) -- the footer's "Follow" links and the contact page's "Elsewhere" list. Settings store handles, and `src/utils/social.ts` turns them into profile URLs.

The `gallery` field is a repeater. Each row contains a required `image` selected from the EmDash media library and an optional `caption`. Render gallery images with `<Image>` from `emdash/ui`; do not reduce media values to raw URLs.

The contact page sends visitors to their email app instead of accepting a form submission. Replace the example address and the studio details in `src/pages/contact.astro` before publishing the site.

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
- Don't pack the home page with every project. "Selected work" shows the six newest; `/work` lists everything.
- Don't add a `gallery` of small thumbnails on the home page. Use one strong image per project; the gallery field renders on the project detail page only.
- Don't add JavaScript animation or smooth-scrolling libraries. Motion is limited to CSS hover and focus effects, and it turns off for visitors who prefer reduced motion.
