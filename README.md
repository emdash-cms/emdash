# EmDash

> [!NOTE]
> This repository is a fork that originally built on Cloudflare-focused work, but it is now a substantially modified and independent codebase. It is not the same repository maintained by Cloudflare.

A full-stack TypeScript CMS built on [Astro](https://astro.build/) for fast, editable business websites. EmDash is designed for developer setup and client handoff: developers build and theme the site, then business owners manage pages, posts, media, and navigation from the admin UI.

## Get Started

```bash
npm create emdash@latest
```

For this fork's default workflow, run on Node.js with SQLite and local file storage.

## Templates

EmDash ships with starter templates:

- Blog
- Marketing
- Portfolio
- Starter
- Blank

Each template includes seed content so you can bootstrap quickly, customize branding, and hand off editing to clients.

## Why EmDash?

**Built for modern JAM-style delivery.** Use Astro for frontend performance and server-rendered content without a PHP stack.

**Developer setup, owner editing.** Developers define layouts and components once. Site owners update content through an admin panel.

**Structured content.** EmDash stores rich text as [Portable Text](https://www.portabletext.org/) JSON so content is reusable across pages and channels.

**WordPress-friendly migration path.** Import posts, pages, media, and taxonomies from WordPress exports and APIs.

## How It Works

EmDash is an Astro integration. Add it to your config and you get a complete CMS: admin panel, REST API, authentication, media library, and content modeling.

```typescript
// astro.config.mjs
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";
import { local } from "emdash/astro";

export default defineConfig({
	integrations: [
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
});
```

Content types are managed through the admin UI, and content is queried directly in Astro routes/components.

```astro
---
import { getEmDashCollection } from "emdash";
const { entries: posts } = await getEmDashCollection("posts");
---

{posts.map((post) => <article>{post.data.title}</article>)}
```

## Features

**Content** -- Pages, posts, custom content types, drafts, revisions, scheduled publishing, and full-text search.

**Admin** -- Visual schema builder, media library, navigation menus, taxonomies, widgets, and WordPress import tools.

**Auth** -- Role-based access control for Administrator, Editor, Author, and Contributor.

**Developer Experience** -- TypeScript-first APIs, CLI tooling, and Astro-native integration.

## Status

EmDash is in **beta preview**. Feedback and contributions are welcome.

```bash
npm create emdash@latest
```

See the [documentation](https://github.com/emdash-cms/emdash/tree/main/docs) for setup and API guides.

## Development

This is a pnpm monorepo. To contribute:

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build
```

Run a local demo (Node.js + SQLite):

```bash
pnpm --filter emdash-demo seed
pnpm --filter emdash-demo dev
```

Open admin at [http://localhost:4321/_emdash/admin](http://localhost:4321/_emdash/admin).

```bash
pnpm test
pnpm typecheck
pnpm lint:quick
pnpm format
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Repository Structure

```
packages/
  core/           Astro integration, APIs, admin UI, CLI
  auth/           Authentication library
  blocks/         Portable Text block definitions
  create-emdash/  npm create emdash scaffolding
  gutenberg-to-portable-text/  WordPress block converter

templates/        Starter templates (blog, marketing, portfolio, starter, blank)
demos/            Development and example sites
docs/             Documentation site (Starlight)
```
