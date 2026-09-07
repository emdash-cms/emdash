# EmDash Cloudflare Demo

This demo shows EmDash running on Cloudflare Workers with D1 database.

Uses Astro 7 + `@astrojs/cloudflare` v14 which runs the real `workerd` runtime in development.

## Setup

1. Start the dev server:

```bash
pnpm dev
```

EmDash runs migrations automatically on first request — no manual migration or DB-create step needed. Wrangler provisions the D1 database on first deploy.

2. Open http://localhost:4321/\_emdash/admin

## Edge HTML cache (Workers Caching)

This demo uses **native Workers Caching**, not the legacy EmDash `cloudflareCache()` helper:

| Piece                | Where                                                              |
| -------------------- | ------------------------------------------------------------------ |
| Platform cache on    | `wrangler.jsonc` → `"cache": { "enabled": true }`                  |
| Astro cache provider | `cacheCloudflare()` from `@astrojs/cloudflare/cache`               |
| Public page TTLs     | `routeRules` in `astro.config.mjs`                                 |
| Purge                | `cache.purge()` from `cloudflare:workers` (no zone ID / API token) |

Do **not** copy `cloudflareCache()` from `@emdash-cms/cloudflare` for new sites. That path stores responses in the Cache API and invalidates via the zone REST purge API (`CF_ZONE_ID` + `CF_CACHE_PURGE_TOKEN`). It is a legacy stopgap; see [Deploy to Cloudflare → Workers Cache](https://docs.emdashcms.com/deployment/cloudflare#workers-cache).

Object/query caching (`objectCache: kvCache({ binding: "CACHE" })`) is a separate layer and is optional.

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

- `astro dev` uses `workerd` (the real Workers runtime) — development matches production
- `wrangler types` runs automatically before dev/build to generate TypeScript types for bindings
- No `platformProxy` config needed — Astro handles this automatically
