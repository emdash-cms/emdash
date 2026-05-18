## This Template

A general-purpose starting point with posts, pages, categories, and tags. Less opinionated than the themed templates -- a base for sites that want to define their own design.

There is intentionally no `theme.css`, no custom font configuration, no styled layouts beyond browser defaults. The home, posts index, post detail, page, category, and tag pages all render with minimal styling. Start here if you want full control over the visual language; start with `blog`, `portfolio`, or `marketing` if you want a designed template to customise.

## Pages

| Page        | Path               | What it shows                                  |
| ----------- | ------------------ | ---------------------------------------------- |
| Home        | `/`                | Site title + tagline, links into Posts / About |
| All posts   | `/posts`           | Post list                                      |
| Post detail | `/posts/[slug]`    | Post content                                   |
| Page        | `/[slug]`          | Static page content (e.g. `/about`)            |
| Category    | `/category/[slug]` | Posts filtered by category                     |
| Tag         | `/tag/[slug]`      | Posts filtered by tag                          |

## Schema

- `posts` collection: `title`, `featured_image`, `content` (Portable Text), `excerpt` (text).
- `pages` collection: `title`, `content` (Portable Text).
- Taxonomies: `category`, `tag`.
- Single `primary` menu.

Site settings have `title` and `tagline`.

## Visual character

None imposed. Define your own.

This template ships without:

- `src/styles/theme.css` -- create one and import it from `Base.astro` if you want CSS-variable theming.
- Fonts in `astro.config.mjs` -- the `fonts:` array is empty. Add Google Fonts entries with `cssVariable` bindings if you want web fonts.
- A `components/` directory with styled cards / tag lists / etc. -- build them as needed.

## What to do here

If you're customising this template, the work is to add design, not to subtract it. Reasonable first moves:

1. Decide on one display + one body typeface, add them to `astro.config.mjs`, bind them to `--font-display` and `--font-body` CSS variables.
2. Create `src/styles/theme.css` with your colour palette, type scale, and spacing tokens.
3. Add it to `Base.astro` -- the layout already imports a small reset; add your theme above your page styles.
4. Build page-specific styles in each Astro page's `<style>` block, referencing the CSS variables.

If you want a designed template instead, switch to `blog`, `portfolio`, or `marketing` -- each ships with a full visual system you can re-skin via `theme.css`.

## What not to do

- Don't treat this as a finished design. The unstyled output is intentional; shipping it as-is looks unfinished because it is.
- Don't add component libraries (Tailwind UI, shadcn, etc.) without considering what they bring with them. The template is small on purpose.
- Don't recreate the blog template's three-column reading view here. If that's what you want, start from `blog`.
