# EmDash service-business template for Cloudflare

This variant runs on Cloudflare Workers and D1 using services available on the Cloudflare free tier. Astro automatically provisions its free-tier KV session namespace. The scaffold intentionally has no R2 bucket, Worker Loader, Durable Object, Cloudflare Images transformation binding, or paid binding.

## Media on the free tier

The starter artwork lives in `public/` and is served through Cloudflare Workers Static Assets at no extra cost. Add replacement images to `public/` and store their paths (for example, `/projects/kitchen.svg`) in project gallery entries.

Persistent uploads through the EmDash media library need object storage. This template does not require that feature. If you later want editor-managed uploads, create an R2 bucket and explicitly add the `r2()` storage adapter and binding described in the EmDash storage documentation. R2 is an optional upgrade, not a deployment prerequisite for this scaffold.

## Start locally

```sh
npm install
npm run dev
```

Create a D1 database, put its ID in `wrangler.jsonc`, and deploy with `npm run deploy`.
