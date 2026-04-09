# EmDash Cloudflare Demo

This demo shows EmDash running on Cloudflare Workers with D1 database.

Uses Astro 6 + `@astrojs/cloudflare` v13 which runs the real `workerd` runtime in development.

## Setup

1. Create a D1 database:

```bash
pnpm db:create
```

2. Copy the database ID from the output and update `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "emdash-demo",
    "database_id": "YOUR_DATABASE_ID_HERE"
  }
]
```

3. Start the dev server:

```bash
pnpm dev
```

EmDash runs migrations automatically on first request — no manual migration step needed.

4. Open http://localhost:4321/\_emdash/admin

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

## Email

This demo includes `@emdash-cms/plugin-worker-mailer` in `astro.config.mjs`.

By default, `workerMailerPlugin()` just enables the SMTP settings page in EmDash so
you can configure the connection in the admin UI.

If you want to seed defaults in code, use:

```js
workerMailerPlugin({
	host: "smtp.example.com",
	port: 587,
	transportSecurity: "starttls",
	authType: "plain",
	username: "smtp-user",
	password: "smtp-password",
	fromEmail: "no-reply@example.com",
	fromName: "EmDash Demo",
});
```

Cloudflare Workers TCP sockets support both STARTTLS and implicit TLS, and this
plugin exposes both modes. Plaintext SMTP is intentionally not supported.

## Notes

- `astro dev` now uses `workerd` (the real Workers runtime) - development matches production
- `wrangler types` runs automatically before dev/build to generate TypeScript types for bindings
- No `platformProxy` config needed - Astro 6 handles this automatically

## TODO

- [ ] R2 storage for media uploads
- [ ] Auth integration (Cloudflare Access or custom)
