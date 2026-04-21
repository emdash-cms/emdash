# Starter Netlify Deployment

This template is optimized for Netlify using `@astrojs/netlify`.

## Local setup

```bash
pnpm install
pnpm setup:business
pnpm setup:hosting --provider=netlify
pnpm bootstrap
pnpm dev
```

## Production env vars

Set these in Netlify site environment variables:

- `DATABASE_URL`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_REGION`
- `S3_PUBLIC_URL`

The template falls back to local SQLite/uploads when these variables are missing, which is intended for local development only.
