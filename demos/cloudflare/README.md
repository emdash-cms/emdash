# EmDash Cloudflare Demo

This demo shows EmDash running on Cloudflare Workers with D1 database.

Uses Astro 6 + `@astrojs/cloudflare` v13 which runs the real `workerd` runtime in development.

## Setup

1. Start the dev server:

```bash
pnpm dev
```

EmDash runs migrations automatically on first request — no manual migration or DB-create step needed. Wrangler provisions the D1 database on first deploy.

2. Open http://localhost:4321/\_emdash/admin

## Preview

After building, you can preview with the real Workers runtime:

```bash
pnpm build
pnpm preview
```

## Deployment

```bash
pnpm deploy
```

This builds and deploys to Cloudflare Workers. EmDash handles migrations automatically on startup.

## Notes

- `astro dev` now uses `workerd` (the real Workers runtime) - development matches production
- `wrangler types` runs automatically before dev/build to generate TypeScript types for bindings
- No `platformProxy` config needed - Astro 6 handles this automatically

## TODO

- [ ] R2 storage for media uploads
- [ ] Auth integration (Cloudflare Access or custom)
