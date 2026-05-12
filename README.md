# EmDash Free Maintenance Edition

[English](README.md) | [简体中文](README.zh-CN.md)

A TypeScript CMS built on [Astro](https://astro.build/) and [Cloudflare](https://www.cloudflare.com/).

> [!IMPORTANT]
> This repository now defaults to a **free-tier maintenance mode**: `worker_loaders` is disabled by default in `wrangler.jsonc`, so you can run on Cloudflare free plan.

## Quick Start

```bash
npm create emdash@latest
```

Or deploy directly to Cloudflare:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/emdash-cms/templates/tree/main/blog-cloudflare)

## Free Mode Notes

| Mode | Description | Paid plan required |
| --- | --- | --- |
| Free maintenance mode | `worker_loaders` disabled. Core CMS stays available (content, admin, auth, media, themes). | No |
| Sandboxed plugin mode | Dynamic Worker Loader enabled. Plugins run in isolated Workers. | Yes |

### Default free-tier wrangler config

`worker_loaders` is commented out by default (enable only when needed).

## Impact of This Change

Normal CMS usage is unaffected for typical site operations. What changes is the Cloudflare sandboxed plugin path: when `worker_loaders` is disabled, sandboxed plugins (and marketplace sandbox loading that depends on it) are not enabled.

If you still need plugins, use one of these:

1. Use `plugins: []` to run your own trusted plugins in-process (non-sandboxed).
2. Upgrade your Cloudflare plan and enable `worker_loaders` + `sandboxRunner` for sandboxed plugins.

## Optional: Enable paid sandboxed plugins

Uncomment in `wrangler.jsonc`:

```jsonc
"worker_loaders": [
	{
		"binding": "LOADER"
	}
]
```

Also configure `sandboxRunner` in `astro.config.mjs` (for example `@emdash-cms/cloudflare/sandbox`).

## Templates

EmDash ships Blog / Marketing / Portfolio / Starter templates.

## Development

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build
```

Run demo (Node.js + SQLite, no Cloudflare account required):

```bash
pnpm --filter emdash-demo seed
pnpm --filter emdash-demo dev
```

Admin URL: [http://localhost:4321/\_emdash/admin](http://localhost:4321/_emdash/admin)

```bash
pnpm test
pnpm typecheck
pnpm lint:quick
pnpm format
```

Docs: [https://docs.emdashcms.com/](https://docs.emdashcms.com/)  
Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
