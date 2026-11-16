# EmDash threat model

## Project and scope

EmDash is an Astro-native content management system. A site serves public pages,
a React admin at `/_emdash/admin`, a REST API under `/_emdash/api`, and an MCP
server. It deploys to Cloudflare Workers with D1, R2, and Worker Loader, or to
Node.js with SQLite, libSQL, or PostgreSQL and S3-compatible or local storage.
Every deployment is reachable from the internet, so a finding in a production
build matters more than one in local development.

Prioritize these components and their shared dependencies:

- `packages/core/`: the runtime, middleware (authentication, CSRF, CSP, request
  context), API routes in `src/astro/routes/api/` and handlers in
  `src/api/handlers/`, content, media, schema, revisions, comments, search,
  previews, visual editing, imports, seeds and transfers, the MCP server in
  `src/mcp/`, the plugin host in `src/plugins/`, and the outbound request guard
  in `src/security/ssrf.ts`.
- `packages/auth/`: passkeys, magic links, OAuth sign-in, invites, signup, API
  tokens, and the permission map in `src/rbac.ts`.
- `packages/workerd/` and `packages/cloudflare/src/sandbox/`: the sandbox runners
  and bridges that execute sandboxed plugins on Node.js and on Workers.
- `packages/cloudflare/`: D1, R2 storage, the image endpoint, and Cloudflare
  Access authentication.
- `packages/admin/`: the admin interface, including how it renders stored
  content, links, embeds, and plugin-provided settings.
- `packages/blocks/`, `packages/gutenberg-to-portable-text/`, and
  `packages/contentful-to-portable-text/`: content conversion and rendering.
- `packages/marketplace/` and the `packages/registry-*` packages: plugin
  discovery, artifact download, verification, and installation.
- `packages/create-emdash/`, `packages/upgrade-emdash/`, and
  `packages/plugin-cli/`: command-line tools that run on developer machines.

Templates in `templates/` matter when their defaults create a realistic unsafe
deployment. Services in `apps/`, demos, documentation, and test fixtures are
lower priority; an intentionally unsafe fixture alone is not a vulnerability.
Astro, Kysely, workerd, and other dependencies are maintained elsewhere; report
an upstream issue only with a reachable EmDash impact.

## Assets and actors

Protect user accounts, sessions, passkey credentials, API and OAuth tokens,
magic-link and invite tokens, unpublished content (drafts, scheduled entries,
trash, and revisions), private media, user email addresses, site settings,
plugin secrets, Worker bindings and environment secrets, and the integrity of
published content, schema, and the database.

Actors, from least to most trusted:

- Anonymous visitors reach public pages, public media, search, comment
  submission, form plugins, OAuth discovery, and sign-in. Before setup
  completes, the setup routes are also public by design.
- Signed-in users hold one role: subscriber, contributor, author, editor, or
  admin. `packages/auth/src/rbac.ts` is the source of truth for what each role
  can do. Every role boundary is a security boundary: a contributor must not
  publish, an author must not edit another user's content, and an editor must
  not change schema, settings, users, or plugins.
- API tokens and OAuth clients, including MCP clients, are limited to both
  their scopes and their user's role.
- Sandboxed plugins are untrusted code. They may use only the capabilities
  declared in their manifest and approved by an admin, through the plugin
  bridge. Reaching undeclared APIs, another plugin's storage, host secrets,
  bindings, or the database outside the bridge, or network hosts outside the
  declared allowlist, is in scope.
- Native plugins registered under `plugins: []` run in the site process and are
  trusted like any other dependency.
- Admins are fully trusted. They can install plugins, edit schema and
  settings, and import or export the whole site, so a finding that needs admin
  access is out of scope. A sandboxed plugin an admin installed is still
  untrusted code and stays limited to its declared capabilities.
- Site developers control `astro.config.mjs`, seeds, templates, and environment
  variables, and are trusted.

## Inputs and trust boundaries

Important untrusted inputs include:

- HTTP requests to the site and API: paths, query strings, cookies, uploads,
  bodies, and headers such as `Host`, `Origin`, and client-IP headers. EmDash
  trusts client-IP headers only when the `trustedProxyHeaders` option or the
  `EMDASH_TRUSTED_PROXY_HEADERS` environment variable names them; an explicit
  option, even `[]`, overrides the variable.
- Stored content rendered on public pages or in the admin: Portable Text, HTML
  blocks, embeds, link URLs, SVG and other uploads, filenames, alt text,
  comment bodies, and plugin settings.
- URLs fetched by the server: media uploads by URL, imported media, embeds,
  registry artifacts, and plugin network requests.
- Import and restore files (WordPress WXR, seeds, transfers, and backups). An
  admin uploads them, but a third party may have written them.
- Messages from sandboxed plugin code to the bridge.
- OAuth responses, redirect parameters, and MCP tool arguments.
- Registry and aggregator records, which relay data they did not author.

Authentication middleware establishes the user; each route then checks
permissions with `requirePerm` or `requireOwnerPerm`. CSRF protection
(`packages/core/src/astro/middleware/auth.ts` and `packages/core/src/api/csrf.ts`)
works like this:

- State-changing requests authenticated by a session cookie, and setup
  requests, must carry `X-EmDash-Request: 1`.
- Requests authenticated with a bearer token skip that check, because tokens
  are not ambient credentials.
- State-changing requests to public routes pass with the header, with an
  `Origin` matching the site, or with no `Origin` at all (a non-browser client
  sends no cookies). A mismatched `Origin` is rejected.
- The OAuth token, client registration, and device-flow endpoints are exempt,
  because they are cross-origin by design and use no cookies.

A request that changes state using a session cookie without passing these
checks is a CSRF finding; the exemptions above are not. Content queries must filter by locale and must
not return drafts, scheduled entries, or trash to a caller without
`content:read_drafts`. Redirect targets must be same-site paths.

HTML blocks without `isolated: true` render sanitized HTML in the page; isolated
blocks run their HTML, CSS, and JavaScript in a sandboxed iframe. Script running
in the site's origin from stored content is cross-site scripting whatever role
wrote it. Server-side fetches of user-supplied URLs must not reach private,
loopback, link-local, or metadata addresses, including through redirects and
DNS rebinding.

The `dev-bypass` endpoints and other development helpers check
`import.meta.env.DEV`. Reaching one in a production build is a finding; using
it in local development is not.

## Building and testing offline

The scanner image keeps the checkout at `/src`, installs the complete pnpm
workspace from the lockfile, downloads Playwright's Chromium, and runs
`pnpm build`. Corepack uses the `packageManager` field in `package.json` for
pnpm. The Dockerfile then runs focused authentication, middleware,
authorization, sanitization, sandbox, and admin browser tests. From `/src`,
useful offline commands are:

```sh
pnpm --filter @emdash-cms/auth exec vitest run
pnpm --filter emdash exec vitest run tests/unit/auth tests/unit/middleware
pnpm --filter emdash exec vitest run tests/unit/api/csrf.test.ts tests/unit/api/content-route-permissions.test.ts
pnpm --filter emdash exec vitest run tests/unit/plugins tests/unit/utils/sanitize.test.ts
pnpm --filter @emdash-cms/sandbox-workerd exec vitest run test/backing-service-authorization.test.ts test/bridge-handler.test.ts test/miniflare-isolation.test.ts test/plugin-integration.test.ts
pnpm --filter @emdash-cms/sandbox-workerd exec vitest run test/runner-env-isolation.test.ts test/wrapper-context.test.ts test/wrapper-storage.test.ts
pnpm --filter @emdash-cms/admin exec vitest run tests/editor/link-destination-input.test.tsx
```

Core tests use a real SQLite database through Node's built-in driver, never a
mock. After changing package source, rebuild with `pnpm build` before running
tests in other packages. Add regression tests beside the existing ones in
`packages/core/tests/unit/`, mirroring the source path.

The full monorepo suite is not an offline smoke test. PostgreSQL parity tests
need a database server, end-to-end tests start Astro dev servers, and
`packages/workerd/test/backing-service.test.ts` fetches `example.com`. Do not
contact production sites, the public plugin registry, or real Cloudflare
accounts to demonstrate a finding.

## Severity and useful reports

Rate findings by demonstrated impact, the attacker's starting access, required
user interaction, and configuration. These are triage guidelines rather than
automatic ratings:

- Critical: compromise of a default deployment without meaningful
  prerequisites, such as unauthenticated code execution on the host or Worker,
  unauthenticated takeover of an admin account, or unauthenticated SQL
  injection that reads or writes the database.
- High: escalation from an anonymous visitor, subscriber, or contributor to
  editor or admin capabilities; stored cross-site scripting that executes in
  another user's admin session; anonymous access to unpublished content or
  private media; a sandboxed plugin escaping its declared capabilities; an API
  or OAuth token exceeding its scopes; SQL injection from a signed-in role
  below admin; or server-side request forgery that returns responses from
  internal addresses.
- Medium: escalation between adjacent roles, such as an author editing another
  user's content; disclosure of limited sensitive data such as user email
  addresses or draft titles; cross-site request forgery on a state-changing
  route; blind server-side request forgery; or an open redirect.
- Low: limited impact with substantial prerequisites, such as denial of
  service that needs a signed-in account.

These are informational or invalid rather than vulnerabilities: anything that
needs admin access, self-XSS, missing hardening headers, and a crash, an
expensive request, or a suspicious pattern without a demonstrated impact.

Explain what the attacker can do beyond their intended permissions, which
deployment targets are affected (Workers, Node.js, or both), and which database
dialects.

Provide the affected package and source location, a minimal reproducer,
exact commands, expected and actual behavior, the role or configuration
required, and a regression test where possible. Use dummy credentials. Prefer
small patches in the lowest shared layer, such as a handler or repository, so
every route that uses it is fixed.
