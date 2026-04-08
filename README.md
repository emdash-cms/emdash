# EmDash

A full-stack TypeScript CMS built on [Astro](https://astro.build/) and [Cloudflare](https://www.cloudflare.com/). EmDash takes the ideas that made WordPress dominant -- extensibility, admin UX, a plugin ecosystem -- and rebuilds them on serverless, type-safe foundations. Plugins run in sandboxed Worker isolates, solving the fundamental security problem with WordPress's plugin architecture.

## Get Started

> [!IMPORTANT]
> EmDash depends on Dynamic Workers to run secure sandboxed plugins. Dynamic Workers are currently only available on paid accounts. [Upgrade your account](https://www.cloudflare.com/plans/developer-platform/) (starting at $5/mo) or comment out the `worker_loaders` block of your `wrangler.jsonc` configuration file to disable plugins.

```bash
npm create emdash@latest
```

Or deploy directly to your Cloudflare account:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/emdash-cms/templates/tree/main/blog-cloudflare)

EmDash runs on Cloudflare (D1 + R2 + Workers) or any Node.js server with SQLite. No PHP, no separate hosting tier -- just deploy your Astro site.

## Templates

EmDash ships with three starter templates:

<table>
<tr>
<td width="33%" valign="top">

### Blog

<a href="assets/templates/blog/latest/"><img src="assets/templates/blog/latest/homepage-light-desktop.jpg" alt="Blog template" width="100%"></a>

A classic blog with sidebar widgets, search, and RSS.

- Categories & tags
- Full-text search
- Comment-ready
- RSS feed
- Dark / light mode

</td>
<td width="33%" valign="top">

### Marketing

<a href="assets/templates/marketing/latest/"><img src="assets/templates/marketing/latest/homepage-light-desktop.jpg" alt="Marketing template" width="100%"></a>

A conversion-focused landing page with pricing and contact form.

- Hero with CTAs
- Feature grid
- Pricing cards
- FAQ and contact form
- Dark / light mode

</td>
<td width="33%" valign="top">

### Portfolio

<a href="assets/templates/portfolio/latest/"><img src="assets/templates/portfolio/latest/work-light-desktop.jpg" alt="Portfolio template" width="100%"></a>

A visual portfolio for showcasing creative work.

- Project grid
- Tag filtering
- Case study pages
- RSS feed
- Dark / light mode
<br /><br />
</td>
</tr>
</table>

## Why EmDash?

**WordPress was built for a different era.** Running WordPress today means managing PHP alongside JavaScript, layering caches to get acceptable performance, and knowing that [96% of WordPress security vulnerabilities come from plugins](https://patchstack.com/whitepaper/state-of-wordpress-security-in-2024/). EmDash is what WordPress would look like if you started from scratch with today's tools.

**Sandboxed plugins.** WordPress plugins have full access to the database, filesystem, and user data. A single vulnerable plugin can compromise the entire site. EmDash plugins run in isolated [Worker sandboxes](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) via Dynamic Worker Loaders, each with a declared capability manifest. A plugin that requests `read:content` and `email:send` can do exactly that and nothing else.

```typescript
export default () =>
	definePlugin({
		id: "notify-on-publish",
		capabilities: ["read:content", "email:send"],
		hooks: {
			"content:afterSave": async (event, ctx) => {
				if (event.content.status !== "published") return;
				await ctx.email.send({
					to: "editors@example.com",
					subject: `New post: ${event.content.title}`,
				});
			},
		},
	});
```

**Structured content, not serialized HTML.** WordPress stores rich text as HTML with metadata embedded in comments -- tying your content to its DOM representation. EmDash uses [Portable Text](https://www.portabletext.org/), a structured JSON format that decouples content from presentation. Your content can render as a web page, a mobile app, an email, or an API response without parsing HTML.

**Built for agents.** EmDash ships with agent skills for building plugins and themes, a CLI that lets agents manage content and schema programmatically, and a built-in [MCP server](https://modelcontextprotocol.io/) so AI tools like Claude and ChatGPT can interact with your site directly.

**Runs anywhere.** EmDash uses portable abstractions at every layer -- Kysely for SQL, S3 API for storage -- that work with SQLite, D1, Turso, PostgreSQL, R2, AWS S3, or local files. It runs best on Cloudflare, but it's not locked to it.

## How It Works

EmDash is an Astro integration. Add it to your config and you get a complete CMS: admin panel, REST API, authentication, media library, and plugin system.

```typescript
// astro.config.mjs
import emdash from "emdash/astro";
import { d1 } from "emdash/db";

export default defineConfig({
	integrations: [emdash({ database: d1() })],
});
```

Content types are defined in the database, not in code. Non-developers create and modify collections through the admin UI. Each collection gets a real SQL table with typed columns. Developers generate TypeScript types from the live schema:

```bash
npx emdash types
```

Query content using Astro's Live Collections -- no rebuilds, no separate API:

```astro
---
import { getEmDashCollection } from "emdash";
const { entries: posts } = await getEmDashCollection("posts");
---

{posts.map((post) => <article>{post.data.title}</article>)}
```

## Features

**Content** -- Blog posts, pages, custom content types. Rich text editing via TipTap with Portable Text storage. Revisions, drafts, scheduled publishing, full-text search (FTS5), inline visual editing.

**Admin** -- Full admin panel with visual schema builder, media library (drag-drop uploads via signed URLs), navigation menus, taxonomies, widgets, and a WordPress import wizard.

**Auth** -- Passkey-first (WebAuthn) with OAuth and magic link fallbacks. Role-based access control: Administrator, Editor, Author, Contributor.

**Plugins** -- `definePlugin()` API with lifecycle hooks, KV storage, settings, admin pages, dashboard widgets, custom block types, and API routes. Sandboxed execution on Cloudflare via Dynamic Worker Loaders.

**Agents** -- Skill files for AI-assisted plugin and theme development. CLI for programmatic site management. Built-in MCP server for direct AI tool integration.

**WordPress migration** -- Import posts, pages, media, and taxonomies from WXR exports, the WordPress REST API, or WordPress.com. Agent skills help port plugins and themes.

## Portable Platforms

| Layer    | Cloudflare                  | Also works with                                     |
| -------- | --------------------------- | --------------------------------------------------- |
| Database | D1                          | SQLite, Turso/libSQL, PostgreSQL                    |
| Storage  | R2                          | AWS S3, any S3-compatible service, local filesystem |
| Sessions | KV                          | Redis, file-based                                   |
| Plugins  | Worker isolates (sandboxed) | In-process (safe mode)                              |

## Status

EmDash is in **beta preview**. We welcome contributions, feedback, plugins, themes, and ideas.

```bash
npm create emdash@latest
```

See the [documentation](https://github.com/emdash-cms/emdash/tree/main/docs) for guides, API reference, and plugin development.

## Development

This is a pnpm monorepo. To contribute:

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build
```

Run the demo (Node.js + SQLite, no Cloudflare account needed):

```bash
pnpm --filter emdash-demo seed
pnpm --filter emdash-demo dev
```

Open the admin at [http://localhost:4321/\_emdash/admin](http://localhost:4321/_emdash/admin).

```bash
pnpm test          # run all tests
pnpm typecheck     # type check
pnpm lint:quick    # fast lint (< 1s)
pnpm format        # format with oxfmt
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

## Repository Structure

```
packages/
  core/           Astro integration, APIs, admin UI, CLI
  auth/           Authentication library
  blocks/         Portable Text block definitions
  cloudflare/     Cloudflare adapter (D1, R2, Worker Loader)
  plugins/        First-party plugins (forms, embeds, SEO, audit-log, etc.)
  create-emdash/  npm create emdash scaffolding
  gutenberg-to-portable-text/  WordPress block converter

templates/        Starter templates (blog, marketing, portfolio, starter, blank)
demos/            Development and example sites
docs/             Documentation site (Starlight)
```
