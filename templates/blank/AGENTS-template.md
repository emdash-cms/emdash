## This Template

The most minimal template. A single `index.astro` page with EmDash wired up and no user seed, styles, components, or layouts beyond what Astro provides by default.

Without a user seed, EmDash applies its built-in posts/pages/categories/tags schema. Start here if you want to replace that baseline and control the public design from the beginning.

## Pages

| Page | Path | What it shows                          |
| ---- | ---- | -------------------------------------- |
| Home | `/`  | A single Astro page with EmDash wiring |

## Schema

There is no template-owned `seed/seed.json`. EmDash applies its built-in posts/pages schema with category and tag taxonomies. Add a user seed when the project needs a different schema or reproducible starter content.

## What to do here

This template is a substrate, not a starting design. The natural first steps are:

1. Decide whether the built-in posts/pages schema fits. Define changes in the admin under Schema, or add `seed/seed.json` when the project needs a reproducible custom schema.
2. Add the pages that render that content (e.g. `src/pages/posts/index.astro`).
3. Add a layout in `src/layouts/` for shared chrome.
4. Add styles -- this template has no `theme.css` and no fonts configured.

If any of that sounds like work you don't want to do, start from `starter`, `blog`, `portfolio`, or `marketing` instead. They make these decisions for you.

## What not to do

- Don't expect this template to render a designed site out of the box. It won't.
- Don't add features here that should live in the EmDash core or in a plugin. This template is meant to stay small.
