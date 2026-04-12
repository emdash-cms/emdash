# Configuration

## astro.config.mjs

### Node.js (local development / self-hosted)

```javascript
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
	devToolbar: { enabled: false },
});
```

### Reverse proxy

When behind a TLS-terminating reverse proxy, `Astro.url` returns the internal address (e.g. `http://localhost:4321`) instead of the public one (`https://mysite.example.com`). This breaks passkeys, CSRF, OAuth, redirects, and more.

**Step 1:** Declare allowed public hosts via [`security.allowedDomains`](https://docs.astro.build/en/reference/configuration-reference/#securityalloweddomains) so Astro reconstructs the URL from `X-Forwarded-*` headers. In dev, add matching **`vite.server.allowedHosts`** or Vite rejects the proxy `Host`.

**Step 2:** If the reconstructed URL still disagrees with the browser (common with TLS termination), set **`siteUrl`**:

```javascript
emdash({
	siteUrl: "https://mysite.example.com",
	// ...
});
```

Or via environment variable (useful for container deployments):

```bash
EMDASH_SITE_URL=https://mysite.example.com
# or: SITE_URL=https://mysite.example.com
```

`siteUrl` replaces `passkeyPublicOrigin` (which only fixed passkeys). It applies to passkeys, CSRF origin matching, OAuth redirects, login redirects, MCP discovery, snapshot exports, sitemap, robots.txt, and JSON-LD structured data.

With TLS terminated in front, **`astro dev --host 127.0.0.1`** (loopback) is usually enough: the proxy reaches the dev server locally while **`siteUrl`** matches the browser’s HTTPS origin -- without opening the Node port on the LAN.

### Cloudflare (D1 + R2)

```javascript
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
		}),
	],
	devToolbar: { enabled: false },
});
```

Requires a `wrangler.jsonc` with D1 and R2 bindings:

```jsonc
{
	"name": "my-site",
	"compatibility_date": "2026-02-24",
	"compatibility_flags": ["nodejs_compat"],
	"assets": { "directory": "./dist" },
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "my-site",
			"database_id": "", // from `wrangler d1 create my-site`
		},
	],
	"r2_buckets": [
		{
			"binding": "MEDIA",
			"bucket_name": "my-site-media",
		},
	],
}
```

### Plugins

Register plugins in `astro.config.mjs`:

```javascript
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";

emdash({
	database: sqlite({ url: "file:./data.db" }),
	storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
	plugins: [auditLogPlugin()],
}),
```

## live.config.ts

Every EmDash site needs this file at `src/live.config.ts`. It's boilerplate -- the same in every project:

```typescript
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
```

This registers EmDash's live content collections with Astro. All content types are served through the single `_emdash` collection -- you query specific types using `getEmDashCollection("posts")` etc.

## emdash-env.d.ts

Auto-generated at the project root when the dev server starts. Provides TypeScript types for your collections. This is the file your `tsconfig.json` includes.

```typescript
/// <reference types="emdash/locals" />

import type { PortableTextBlock } from "emdash";

export interface Post {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	featured_image?: {
		id: string;
		src?: string;
		alt?: string;
		width?: number;
		height?: number;
	};
	content?: PortableTextBlock[];
	excerpt?: string;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
}

declare module "emdash" {
	interface EmDashCollections {
		posts: Post;
	}
}
```

The dev server regenerates this file automatically when schema changes. You can also generate it manually:

## Type Generation

```bash
# From local dev server (writes emdash-env.d.ts at project root)
npx emdash types

# From remote instance
npx emdash types --url https://my-site.pages.dev

# Custom output path
npx emdash types --output src/types/cms.ts
```

The CLI also writes `.emdash/schema.json` with the raw schema for tooling.

## package.json

Key dependencies for a Node.js site:

```json
{
	"dependencies": {
		"astro": "^6.0.0",
		"emdash": "workspace:*",
		"@astrojs/node": "^9.0.0",
		"@astrojs/react": "^4.0.0",
		"react": "^18.0.0",
		"react-dom": "^18.0.0"
	}
}
```

For Cloudflare, replace `@astrojs/node` with `@astrojs/cloudflare` and add `@emdash-cms/cloudflare`.

## Dev Server

```bash
npx emdash dev              # Start dev server (runs migrations, applies seed)
npx emdash dev --types      # Start and generate types from schema
```

The admin UI is at `http://localhost:4321/_emdash/admin`. On first run, you'll go through setup to create an admin account.
