# Symballo Starter (SvelteKit)

This is the Svelte 5/SvelteKit local-business starter.

## Development

```bash
pnpm install
pnpm dev
```

## What to edit first

- `data/cms.json`: business identity, hours, posts, pages
- `src/routes/+page.svelte`: landing page layout/content blocks
- `src/styles.css`: visual styling

## Routes

- `/`: landing page
- `/posts`: post list
- `/posts/[slug]`: post detail
- `/pages/[slug]`: page detail
- `/admin`: built-in Svelte admin panel for editing site details, posts, and pages
