# Symballo Starter (SvelteKit)

This is the Svelte 5/SvelteKit migration target for the local-business starter.

## Development

```bash
pnpm install
pnpm dev
```

## What to edit first

- `src/lib/content.ts`: business identity, hours, social links, starter pages/posts
- `src/routes/+page.svelte`: landing page layout/content blocks
- `src/styles.css`: visual styling

## Routes

- `/`: landing page
- `/posts`: post list
- `/posts/[slug]`: post detail
- `/pages/[slug]`: page detail
- `/admin`: reserved link target for future admin integration
