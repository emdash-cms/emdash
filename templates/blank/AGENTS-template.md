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
