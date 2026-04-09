# EmDash — Product Requirements Document

## 1. Executive Summary

EmDash is a full-stack TypeScript CMS built on Astro and designed to run on Cloudflare or Node.js. It provides the familiar content-management capabilities of WordPress—posts, pages, media, taxonomies, menus, plugins, users—reimplemented with a modern, type-safe, serverless-first architecture. The product stores its schema in the database rather than in code, runs plugins in isolated Worker sandboxes, and ships with a built-in MCP server so AI agents can interact with site content natively.

---

## 2. Problem Statement

### 2.1 The WordPress Problem

WordPress powers ~43 % of the web, yet it carries significant structural problems that have become harder to paper over as the web matured:

| Problem                                                         | Impact                                                                                                     |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 96 % of WordPress security vulnerabilities originate in plugins | Any installed plugin has full database and filesystem access                                               |
| PHP + plugin compatibility matrix                               | Hours of maintenance on every major update                                                                 |
| HTML-as-content-format                                          | Rich text is stored as DOM markup, coupling content to presentation and making programmatic access fragile |
| No native type safety                                           | Developers must maintain parallel TypeScript type definitions that can drift from the actual schema        |
| Separate PHP + hosting stack                                    | Multi-tier infrastructure that is expensive to operate and difficult to scale predictably                  |

### 2.2 The Headless CMS Gap

Modern headless CMS products (Contentful, Sanity, etc.) decouple content from presentation but introduce a different set of problems:

- Schema lives in a proprietary cloud, not in the developer's codebase or database
- API calls at render time add latency and cost
- Vendor lock-in on data format, API shape, and pricing tiers
- Astro's content collection primitives are purpose-built for this use case but no CMS yet integrates natively with Astro's live collection API

### 2.3 What EmDash Does Differently

EmDash occupies the gap between "managed WordPress" and "generic headless CMS" by being:

1. **Developer-owned infrastructure** — the database is yours (D1, SQLite, PostgreSQL, libSQL)
2. **Astro-native** — integrates directly with Astro's Live Content Collections; no rebuild required when content changes
3. **Schema in the database** — non-developers can create and modify content types through the admin UI without a code deployment
4. **Sandboxed plugins** — plugins declare a capability manifest and run in isolated Worker environments; they cannot access what they did not declare
5. **Portable Text** — rich text is stored as structured JSON, not HTML, decoupling content from any particular renderer

---

## 3. Goals

### 3.1 Product Goals

- **G1 — Drop-in CMS for Astro projects.** An Astro developer should be able to add a fully functional CMS to an existing project in under an hour.
- **G2 — WordPress parity for common use cases.** Cover the content management scenarios that 80 % of WordPress sites actually use: posts, pages, media, taxonomies, menus, widgets, users, roles.
- **G3 — Trustworthy plugin ecosystem.** Plugins must be sandboxed by default. Installing a plugin from an unknown author should not be a security risk.
- **G4 — AI-agent readiness.** Site content and management operations must be accessible to AI agents through a standard protocol (MCP) without additional integration work.
- **G5 — Cloud portability.** Code written for Cloudflare Workers must run on Node.js with only an adapter swap; no platform lock-in.

### 3.2 Business Goals (Beta Phase)

- Establish a developer community around the open-source core
- Publish a plugin ecosystem with at least 8 first-party plugins at launch
- Provide migration tooling that lowers the switching cost from WordPress
- Reach a stable v1 API that can carry a compatibility guarantee

### 3.3 Non-Goals

- **Not a page builder.** EmDash does not ship a drag-and-drop visual page editor. Layout is handled by Astro components.
- **Not a managed hosting service.** EmDash provides the self-hosted CMS layer; hosting is the operator's responsibility.
- **Not a general-purpose backend.** EmDash is a CMS, not an application server. Non-content business logic belongs in plugins or external services.

---

## 4. Success Metrics

| Metric                                                | Target                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| Time to first running admin panel (new Astro project) | < 15 minutes                                        |
| WordPress import fidelity (posts + media + taxonomy)  | ≥ 95 % of content reproduced correctly              |
| Plugin sandbox escape rate                            | 0 — capability manifest is enforced, not advisory   |
| Type errors in generated types                        | 0 — `npx emdash types` output passes `tsc --noEmit` |
| Test coverage (unit + integration, packages/core)     | ≥ 80 % statement coverage                           |
| CI green rate on `main`                               | ≥ 99 %                                              |

---

## 5. User Personas

### P1 — The Agency Developer

**Background:** Builds 10–20 client sites per year. Needs a CMS that non-technical clients can use. Wants reusable plugins and themes. Burned by WordPress security incidents and the PHP upgrade treadmill.

**Needs:**

- Fast project setup with starter templates
- Role-based access so clients can edit without breaking things
- Plugin system that is safe to sell to clients
- Deployable to cost-effective infrastructure (Cloudflare Workers)

### P2 — The Full-Stack Solo Developer

**Background:** Builds personal projects and small SaaS products. Prefers a single TypeScript stack from database to UI. Wants type-safe content queries without a separate type-definition maintenance burden.

**Needs:**

- Generated TypeScript types from the live schema
- Query helpers that integrate naturally with Astro components
- Local development that mirrors production closely
- No separate managed service to pay for during experimentation

### P3 — The Content Editor

**Background:** Non-technical. Creates and publishes articles, uploads images, manages navigation menus. Evaluates the CMS by how intuitive the admin panel is.

**Needs:**

- Rich text editor that feels familiar (comparable to Gutenberg or Google Docs)
- Reliable draft/publish workflow with scheduling
- Media library with drag-and-drop upload
- Clear feedback on errors and confirmations for destructive actions

### P4 — The WordPress Migrator

**Background:** Running an existing WordPress site. Frustrated by maintenance costs but cannot afford to rebuild content. Wants a migration path, not a greenfield rewrite.

**Needs:**

- Import from WXR exports, WordPress REST API, or WordPress.com
- Equivalent concepts for posts, pages, categories, tags, menus, widgets
- Plugin equivalents for common WordPress plugin categories (forms, SEO, analytics)

### P5 — The AI-First Developer

**Background:** Builds with Claude, ChatGPT, or custom agents. Wants site content accessible to agents programmatically. May use AI to draft content or automate publishing workflows.

**Needs:**

- MCP server available out of the box
- CLI for scripted content operations
- Predictable JSON API with consistent pagination and error shapes

---

## 6. Feature Requirements

### 6.1 Content Management

#### 6.1.1 Collections

| ID    | Requirement                                                                                                                                                                                | Priority |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| CM-01 | Admin can create a new collection with a name, slug, and description through the UI                                                                                                        | P0       |
| CM-02 | Each collection is stored as a real SQL table (`ec_{slug}`) with typed columns                                                                                                             | P0       |
| CM-03 | Admin can add, edit, and remove fields from a collection through the UI                                                                                                                    | P0       |
| CM-04 | Supported field types: text, long text, number, integer, boolean, date/datetime, email, URL, select (single), multiselect, image, reference (foreign key), rich text (Portable Text), JSON | P0       |
| CM-05 | Slug validation enforces `/^[a-z][a-z0-9_]*$/`, max 63 chars, and reserved-word block list                                                                                                 | P0       |
| CM-06 | Deleting a collection drops the SQL table and removes all associated metadata                                                                                                              | P0       |
| CM-07 | `npx emdash types` generates a TypeScript interface for every collection                                                                                                                   | P1       |

#### 6.1.2 Entries

| ID    | Requirement                                                                                      | Priority |
| ----- | ------------------------------------------------------------------------------------------------ | -------- |
| CM-10 | Editor can create, read, update, and delete entries in any collection they have access to        | P0       |
| CM-11 | Entries have a status field: `draft`, `published`, `scheduled`, `deleted`                        | P0       |
| CM-12 | Publishing an entry sets `published_at` and makes it visible via the public query API            | P0       |
| CM-13 | Scheduling sets `scheduled_at`; a background job transitions the entry to published at that time | P0       |
| CM-14 | Soft delete moves entries to `status = deleted`; hard delete is a separate privileged action     | P0       |
| CM-15 | Every save creates a revision record; editor can view and restore previous revisions             | P1       |
| CM-16 | Entries support per-locale variants linked by a translation group ID                             | P1       |

#### 6.1.3 Rich Text

| ID    | Requirement                                                                       | Priority |
| ----- | --------------------------------------------------------------------------------- | -------- |
| CM-20 | Rich text fields use TipTap as the editing interface                              | P0       |
| CM-21 | All rich text is stored as Portable Text (structured JSON), not HTML              | P0       |
| CM-22 | Plugins can register custom Portable Text block types                             | P1       |
| CM-23 | A `renderPortableText()` helper renders Portable Text to HTML or Astro components | P1       |

### 6.2 Media

| ID    | Requirement                                                                                   | Priority |
| ----- | --------------------------------------------------------------------------------------------- | -------- |
| MD-01 | Editor can upload images and documents via drag-and-drop in the admin panel                   | P0       |
| MD-02 | Uploads use signed URLs; files go directly to storage without proxying through the CMS server | P0       |
| MD-03 | Media library displays all uploaded files with search and filter                              | P0       |
| MD-04 | Image entries store width, height, MIME type, and a blurhash placeholder                      | P1       |
| MD-05 | Editor can update the alt text, title, and caption of any media item                          | P1       |
| MD-06 | Storage backend is pluggable: Cloudflare R2, S3-compatible (AWS, MinIO), or local filesystem  | P0       |

### 6.3 Taxonomies

| ID    | Requirement                                                                                | Priority |
| ----- | ------------------------------------------------------------------------------------------ | -------- |
| TX-01 | Admin can define custom taxonomies (analogous to WordPress post formats, tags, categories) | P0       |
| TX-02 | Taxonomies support flat and hierarchical structures                                        | P0       |
| TX-03 | Terms can be assigned to entries in any collection                                         | P0       |
| TX-04 | `getTaxonomyTerms()` runtime helper returns terms for a given taxonomy                     | P0       |

### 6.4 Menus & Widgets

| ID    | Requirement                                                                                     | Priority |
| ----- | ----------------------------------------------------------------------------------------------- | -------- |
| MW-01 | Admin can create navigation menus with arbitrary items (internal links, external links, labels) | P0       |
| MW-02 | Menu items support hierarchical nesting with drag-and-drop reordering                           | P0       |
| MW-03 | `getMenu(slug)` runtime helper returns the menu tree                                            | P0       |
| MW-04 | Admin can define widget areas and place content, menu, and component widgets                    | P1       |
| MW-05 | `getWidgetArea(slug)` runtime helper returns widgets for an area                                | P1       |

### 6.5 Full-Text Search

| ID    | Requirement                                                            | Priority |
| ----- | ---------------------------------------------------------------------- | -------- |
| SR-01 | Full-text search is backed by SQLite FTS5 with Porter stemming         | P0       |
| SR-02 | Indexed fields are configurable per collection                         | P0       |
| SR-03 | `search(query, { collections })` runtime helper returns ranked results | P0       |
| SR-04 | Admin panel includes a search rebuild action                           | P1       |

### 6.6 Authentication & Authorization

| ID    | Requirement                                                                                                            | Priority |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| AU-01 | Primary authentication method is WebAuthn (passkeys)                                                                   | P0       |
| AU-02 | Magic-link (email) authentication is available as a fallback                                                           | P0       |
| AU-03 | OAuth authentication is available via configurable providers                                                           | P1       |
| AU-04 | Roles: Administrator, Editor, Author, Contributor                                                                      | P0       |
| AU-05 | Administrators can create users, assign roles, and revoke access                                                       | P0       |
| AU-06 | Every state-changing API endpoint requires the `X-EmDash-Request: 1` header (CSRF protection)                          | P0       |
| AU-07 | Dev-only bypass endpoints (`/_emdash/dev/setup`, `/_emdash/dev/auth`) are disabled when `import.meta.env.DEV` is false | P0       |

### 6.7 Plugin System

| ID    | Requirement                                                                                                                       | Priority |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PL-01 | Plugins are defined with `definePlugin({ name, capabilities, hooks, ... })`                                                       | P0       |
| PL-02 | Each plugin declares a capability manifest; it can only access declared capabilities                                              | P0       |
| PL-03 | On Cloudflare, plugins execute in isolated Worker sandboxes (Dynamic Worker Loaders)                                              | P0       |
| PL-04 | On Node.js, plugins run in a restricted in-process safe mode                                                                      | P0       |
| PL-05 | Hook types: `content:beforeSave`, `content:afterSave`, `content:afterPublish`, `content:afterDelete`, and request-lifecycle hooks | P0       |
| PL-06 | Plugins can store per-plugin key-value data via the plugin storage API                                                            | P1       |
| PL-07 | Plugins can expose configuration through admin-rendered settings pages                                                            | P1       |
| PL-08 | Plugins can add custom admin pages, dashboard widgets, and API routes                                                             | P1       |
| PL-09 | Plugins can register custom Portable Text block types                                                                             | P1       |
| PL-10 | Plugin marketplace for runtime discovery and installation (architecture only in beta)                                             | P2       |

**First-party plugins shipped at launch:**

| Plugin           | Capability                                    |
| ---------------- | --------------------------------------------- |
| Forms            | Form builder and submission storage           |
| Embeds           | oEmbed for YouTube, Vimeo, etc.               |
| Audit Log        | Immutable log of all content and user actions |
| AI Moderation    | Content moderation via Cloudflare Workers AI  |
| Webhook Notifier | HTTP webhooks on content lifecycle events     |
| ATProto          | Publish to Bluesky / ActivityPub              |
| Color Picker     | Custom color field type                       |
| Payments (X402)  | Stripe-backed gated content                   |

### 6.8 Admin Panel

| ID    | Requirement                                                                             | Priority |
| ----- | --------------------------------------------------------------------------------------- | -------- |
| AP-01 | Admin panel is a React SPA served at `/_emdash/admin/`                                  | P0       |
| AP-02 | Panel uses TanStack Router for type-safe client-side routing                            | P0       |
| AP-03 | Dashboard shows recent activity and key content metrics                                 | P1       |
| AP-04 | Schema editor allows creating and modifying collections and fields without a deployment | P0       |
| AP-05 | All data tables support sorting, filtering, and cursor-based pagination                 | P0       |
| AP-06 | Confirmation dialogs are required before destructive actions                            | P0       |
| AP-07 | Form validation matches server-side schema (React Hook Form + Zod)                      | P0       |
| AP-08 | Design system: Cloudflare Kumo (Base UI + Tailwind CSS)                                 | P0       |

### 6.9 Public Content API

| ID    | Requirement                                                                         | Priority |
| ----- | ----------------------------------------------------------------------------------- | -------- |
| CA-01 | `getEmDashCollection(slug, options?)` returns a filtered, paginated list of entries | P0       |
| CA-02 | `getEmDashEntry(collection, slugOrId)` returns a single entry                       | P0       |
| CA-03 | `getSiteSettings()` returns site name, description, and global config               | P0       |
| CA-04 | `getMenu(slug)` returns a navigation menu tree                                      | P0       |
| CA-05 | `getTaxonomyTerms(taxonomy)` returns all terms in a taxonomy                        | P0       |
| CA-06 | `getWidgetArea(slug)` returns widgets configured for an area                        | P1       |
| CA-07 | `search(query, options?)` returns full-text search results                          | P0       |
| CA-08 | All list results use cursor-based pagination with `{ items, nextCursor? }` shape    | P0       |
| CA-09 | Integrates with Astro Live Content Collections (no rebuild on content change)       | P0       |

### 6.10 WordPress Migration

| ID    | Requirement                                                                  | Priority |
| ----- | ---------------------------------------------------------------------------- | -------- |
| WP-01 | Import posts, pages, media, categories, and tags from a WXR export file      | P0       |
| WP-02 | Import from a live WordPress site via the WordPress REST API                 | P1       |
| WP-03 | Import from WordPress.com via its API                                        | P1       |
| WP-04 | Convert Gutenberg blocks to Portable Text during import                      | P1       |
| WP-05 | Media files are downloaded and re-uploaded to the configured storage backend | P0       |

### 6.11 AI / Agent Integration

| ID    | Requirement                                                                                           | Priority |
| ----- | ----------------------------------------------------------------------------------------------------- | -------- |
| AI-01 | Built-in MCP server at `/_emdash/api/mcp` requires no additional configuration                        | P0       |
| AI-02 | MCP server exposes tools for reading entries, creating entries, updating entries, and querying search | P0       |
| AI-03 | `emdash` CLI supports content and schema operations for scripted/programmatic workflows               | P1       |
| AI-04 | `npx emdash types` generates TypeScript types from the live schema                                    | P1       |

---

## 7. Non-Functional Requirements

### 7.1 Performance

| Requirement                                  | Target                                        |
| -------------------------------------------- | --------------------------------------------- |
| Admin panel initial load (cached assets)     | < 2 s on a 4G connection                      |
| Content API response (single entry, warm DB) | < 50 ms (Cloudflare edge), < 100 ms (Node.js) |
| Media upload to storage (10 MB image)        | < 5 s on a standard broadband connection      |
| Full-text search (FTS5 query, 10 k entries)  | < 100 ms                                      |

### 7.2 Security

- All SQL queries use Kysely's parameterized query builder. Raw SQL template strings containing variables are forbidden except with validated identifiers via `validateIdentifier()`.
- Plugin sandbox is enforced at the Worker isolate level on Cloudflare; capability violations throw, not warn.
- Authentication tokens are HttpOnly, Secure cookies. No JWT stored in localStorage.
- CSRF protection via `X-EmDash-Request` header is enforced by middleware, not per-route.
- Redirect URL parameters must begin with `/` and must not begin with `//` (protocol-relative redirect prevention).
- Dev-only endpoints return HTTP 403 when `import.meta.env.DEV` is false (compile-time constant).

### 7.3 Reliability

- Database migrations are versioned, type-safe, and run automatically on startup.
- Orphaned content tables (from a crashed schema migration) are detected and reported.
- Soft deletes are the default; hard deletes are privileged and irreversible.
- All list endpoints are paginated; no unbounded queries.

### 7.4 Portability

- No Cloudflare-specific APIs in the core content query layer.
- Storage, database, and session backends are swappable via adapter pattern.
- Code written for the Cloudflare adapter must work on Node.js by swapping adapters with no application code changes.

### 7.5 Developer Experience

- TypeScript strict mode (`noUncheckedIndexedAccess`, `noImplicitOverride`) throughout.
- `pnpm lint:quick` completes in under 1 second and returns JSON output.
- `pnpm typecheck` catches errors before CI.
- Every public API is typed; no `any` in exported signatures.
- Generated types pass `tsc --noEmit` without modification.

### 7.6 Accessibility

- Admin panel meets WCAG 2.1 AA at a minimum.
- All interactive components are keyboard navigable.
- Kumo design system components handle ARIA roles and focus management.

---

## 8. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Astro Site                                                      │
│  ┌───────────────────┐   ┌─────────────────────────────────┐   │
│  │  .astro Components│   │  EmDash Astro Integration        │   │
│  │  getEmDashEntry() │◄──│  Middleware chain:               │   │
│  │  getEmDashColl..()│   │  runtime init → setup check →    │   │
│  └───────────────────┘   │  auth → request context (ALS)    │   │
│                          └───────────┬─────────────────────┘   │
│                                      │                          │
│                          ┌───────────▼─────────────────────┐   │
│                          │  EmDash Runtime                  │   │
│                          │  ┌──────────┐ ┌───────────────┐ │   │
│                          │  │ Kysely   │ │ Storage       │ │   │
│                          │  │ (D1 /    │ │ (R2 / S3 /    │ │   │
│                          │  │  SQLite/ │ │  local)       │ │   │
│                          │  │  PG /    │ └───────────────┘ │   │
│                          │  │  libSQL) │ ┌───────────────┐ │   │
│                          │  └──────────┘ │ Plugin Manager│ │   │
│                          │               │ (Worker isol.)│ │   │
│                          │               └───────────────┘ │   │
│                          └─────────────────────────────────┘   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Admin SPA  /_emdash/admin/                               │  │
│  │  React + TanStack Router/Query + Kumo                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─────────────────────┐   ┌──────────────────────────────┐    │
│  │  REST API            │   │  MCP Server                  │    │
│  │  /_emdash/api/...   │   │  /_emdash/api/mcp            │    │
│  └─────────────────────┘   └──────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Decision                                | Rationale                                                             |
| --------------------------------------- | --------------------------------------------------------------------- |
| Schema stored in database, not code     | Non-developers can create content types; schema survives code deploys |
| Real SQL tables per collection (`ec_*`) | Full SQL indexing, joins, and query optimization; no EAV anti-pattern |
| Portable Text for rich content          | Decouples content from renderer; machine-readable for AI agents       |
| Plugins in Worker isolates              | Security boundary at the OS/V8 level; no shared memory with the host  |
| Cursor-based pagination everywhere      | Stable pages under concurrent writes; no `OFFSET` performance cliffs  |
| `ApiResponse<T>` envelope               | Consistent discriminated union enables safe client-side unwrapping    |

---

## 9. Deployment

### Cloudflare Workers (Recommended)

- **Database:** D1 (serverless SQLite with read replicas)
- **Storage:** R2 (S3-compatible object storage)
- **Sessions:** KV
- **Plugin sandbox:** Dynamic Worker Loaders (requires Workers Paid plan)
- **Setup:** `wrangler.jsonc` + `npx emdash deploy`

### Node.js

- **Database:** SQLite (file), PostgreSQL, or libSQL/Turso
- **Storage:** Local filesystem, S3, or R2 (S3 API)
- **Sessions:** File or Redis
- **Plugin sandbox:** In-process safe mode (no isolates)
- **Platforms:** Vercel, Railway, Fly.io, self-hosted VPS, Docker

### Local Development

- SQLite in-memory or file + local filesystem storage
- `pnpm --filter emdash-demo dev` starts at `http://localhost:4321`

---

## 10. Risks & Mitigations

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                                                                 |
| ------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Dynamic Workers requirement alienates users on free tier | High       | Medium | Document in-process plugin mode clearly; core CMS features (excluding sandboxed plugins) work without paid plan                            |
| Portable Text adoption curve for existing Astro developers          | Medium     | Medium | Provide `renderPortableText()` helpers and migration docs; keep escape hatch to raw HTML for simple cases                                  |
| SQLite limitations at scale (single writer)                         | Medium     | Medium | D1 read-replica support; clear guidance to upgrade to PostgreSQL/libSQL for high-write use cases                                           |
| Plugin marketplace security when third-party plugins are introduced | Low (beta) | High   | Capability manifest enforcement at Worker-isolate level; code signing and review process defined before marketplace GA                     |
| API instability during beta breaking early adopters                 | High       | Medium | Explicit pre-release labeling; no deprecations—breaking changes are removed cleanly; changeset-based releases communicate breaking changes |

---

## 11. Out of Scope (v1)

The following are explicitly deferred to post-v1 or not planned:

- **Password authentication.** Passkeys, magic links, and OAuth are the only supported auth mechanisms. Password-based login is not planned.
- **Visual page builder / drag-and-drop layout editor.** Layout is composed in Astro components, not an in-browser editor.
- **Plugin marketplace runtime installation.** The architecture is present in beta; the marketplace UX and trust model are post-v1.
- **Real-time collaborative editing.** Multi-user simultaneous editing with operational transforms or CRDTs is planned for post-v1.
- **Rate limiting on authentication endpoints.** Brute-force protection is noted and planned; not in scope for beta.
- **Plugin auto-updates.** Operators trigger plugin updates manually; automatic version pinning and upgrade flows are future work.
- **First-party managed hosting.** EmDash is self-hosted. No SaaS hosting offering is planned at this time.

---

## 12. Glossary

| Term                               | Definition                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| **Collection**                     | A user-defined content type; maps to a SQL table (`ec_{slug}`)                               |
| **Entry**                          | A single row in a collection's table                                                         |
| **Portable Text**                  | A JSON schema for structured rich text; format used by Sanity and adopted by EmDash          |
| **Capability manifest**            | The set of permissions a plugin declares it needs; enforced at sandbox boundary              |
| **Dynamic Worker Loaders**         | Cloudflare Workers feature that spawns isolated V8 contexts at runtime for plugin sandboxing |
| **FTS5**                           | SQLite's fifth-generation full-text search extension                                         |
| **MCP**                            | Model Context Protocol — a standard for exposing tools and resources to AI agents            |
| **D1**                             | Cloudflare's serverless SQLite offering with global read replicas                            |
| **R2**                             | Cloudflare's S3-compatible object storage (zero egress fees)                                 |
| **WXR**                            | WordPress eXtended RSS — the standard WordPress export/import format                         |
| **Astro Live Content Collections** | Astro's runtime-queryable content API; EmDash integrates as a collection source              |
| **`ec_*` table**                   | Naming convention for EmDash content tables (`ec_posts`, `ec_products`, etc.)                |

---

_Last updated: 2026-04-09_
