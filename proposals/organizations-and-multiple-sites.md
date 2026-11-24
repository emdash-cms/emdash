---
title: Organizations and multiple sites per deployment
type: rfc
status: proposed
authors:
  - Srikanth K (@oh-tarnished)
champion: Srikanth K (@oh-tarnished)
sponsor: TBD
discussions: []
created: 2026-11-24
---

# Organizations and multiple sites per deployment

> **Draft.** This RFC needs a Maintainer sponsor and an Ideas Discussion, and the [open questions](#open-questions) need answers before acceptance.

## Summary

This RFC lets one EmDash deployment serve many sites that belong to organizations, with one set of users and one role model across every site in an organization.

- **A control-plane database** holds organizations, sites, users, credentials, sessions, and organization memberships. It is new and separate from site databases.
- **Each site keeps its own database and media storage.** Collections, `ec_*` tables, menus, taxonomies, settings, and media stay exactly as they are today. Content queries gain no `site_id` filter.
- **Middleware resolves the site from the request hostname** and runs the request on that site's database and storage through the existing per-request database override.
- **Roles come from organization membership.** A member's organization role applies to every site in the organization, and an optional per-site role overrides it. The `Permissions` map in `packages/auth/src/rbac.ts` does not change.
- **Off by default.** A deployment without a `sites` configuration runs as a single site, exactly as it does today.

## Problem and user case

An agency or a company with several brands runs many websites. Today each EmDash site is a separate deployment with its own database, its own users, and its own roles. Giving an editor access to ten sites means ten invitations, ten passkeys or logins, and ten role assignments, and removing that editor means repeating the work ten times. Nothing shows the operator which sites exist or who can reach them.

Cloudflare Access with `roleMapping` and `syncRoles` already gives identity-provider groups the same role on each site deployment. It requires Cloudflare Access and an identity provider, applies one role to every site the Access application covers, and still needs a deployment, database, and Access application per site. It does not help Node.js deployments.

## Example

An agency runs the organization `acme` with two sites, `brand-a.com` and `brand-b.com`, from one deployment.

1. Priya, an organization Admin, opens `https://admin.example.com/_emdash/admin`, signs in once, and sees a site switcher listing both sites.
2. Priya invites Ravi to the organization as an Editor. Ravi can edit and publish content on both sites.
3. Priya gives Ravi the Author role on `brand-b.com` only. On that site Ravi can edit and publish only their own entries.
4. A visitor requests `https://brand-a.com/blog/launch`. Middleware maps `brand-a.com` to the site, and the page renders from brand A's database. Brand B's content is unreachable from that request.
5. Priya removes Ravi from the organization. Ravi's sessions end and Ravi loses access to both sites.

## Goals

- One deployment serves many sites, each with an isolated database and media storage.
- Organizations group sites. Users, credentials, and sessions are shared across the deployment.
- One membership grants a role on every site in an organization, with an optional per-site override.
- Authorization keeps the existing `Permissions` map, `requirePerm`, and `requireOwnerPerm`.
- Cloudflare Workers (D1, Durable Object SQLite, R2) and Node.js (SQLite, libSQL, PostgreSQL, S3, local storage).
- Existing single-site deployments upgrade with no configuration change and no data migration.
- No added queries on logged-out routes in the steady state.

## Non-goals

- Sharing content, media, or schema between sites. Each site has its own collections.
- Creating site databases or R2 buckets through the admin. The operator provisions them; this RFC only registers them.
- Billing, quotas, or plan limits per organization.
- Per-site plugin code. Every site in a deployment runs the same plugin build; activation and settings stay per site.
- Custom roles or new permission strings.

## Detailed design

### Configuration

`emdash()` gains an optional `sites` option. When it is absent, nothing in this RFC runs.

```ts title="astro.config.mjs"
emdash({
	database: d1({ binding: "DB" }),
	storage: r2({ binding: "MEDIA" }),
	sites: multiSite({
		controlPlane: d1({ binding: "CONTROL_DB" }),
		adminHost: "admin.example.com",
		resolveDatabase: (site) => d1({ binding: site.databaseRef }),
		resolveStorage: (site) => r2({ binding: site.storageRef }),
	}),
});
```

- `controlPlane` is a `DatabaseDescriptor`, so every supported database works.
- `adminHost` is the canonical origin for sign-in and the admin. See [Identity and passkeys](#identity-and-passkeys).
- `resolveDatabase` and `resolveStorage` turn a site's stored references into descriptors. On Workers a reference names a binding; on Node.js it names a file path, connection string, or bucket. Secrets stay in environment variables; the control plane stores only names.
- The top-level `database` and `storage` are the default site, which keeps existing content reachable when multi-site is turned on.

### Control-plane data model

Migrations for the control plane run from their own migration set, separate from site migrations.

| Table                         | Columns                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `_emdash_orgs`                | `id`, `slug` (unique), `name`, `created_at`, `updated_at`                           |
| `_emdash_sites`               | `id`, `org_id`, `slug`, `name`, `database_ref`, `storage_ref`, `status`, timestamps |
| `_emdash_site_hosts`          | `hostname` (primary key, lower-case), `site_id`, `is_primary`                       |
| `_emdash_org_members`         | `org_id`, `user_id`, `role`, `created_at`; primary key `(org_id, user_id)`          |
| `_emdash_site_role_overrides` | `site_id`, `user_id`, `role`; primary key `(site_id, user_id)`                      |

`users`, `credentials`, sessions, invitations, API tokens, and OAuth tables move to the control plane in multi-site mode, using the same schema as the site database. Foreign key columns are indexed.

### Site resolution

A new middleware step runs after runtime init and before setup and auth:

1. Normalize the request hostname to lower case without a port.
2. Look up `_emdash_site_hosts` through a deployment-wide cache stored on `globalThis` under a `Symbol.for` key, refreshed on a version stamp the same way site settings are.
3. On a hit, create the site's request-scoped database and storage, and run the rest of the request with `db`, `dbIsIsolated: true`, and the site's storage in the request context.
4. On `adminHost`, use the site the user selected (a `site` cookie, checked against membership on every request).
5. On a miss, return 404 without touching any site database.

`dbIsIsolated` already makes schema-derived caches (manifest, taxonomy definitions, collection slugs, byline field definitions) skip cross-request reuse. Multi-site changes those caches to key on the site ID instead, so each site keeps its cache.

### Identity and passkeys

WebAuthn binds a passkey to one registrable domain, so a passkey created on `brand-a.com` cannot sign in on `brand-b.com`. All sign-in, sign-up, invitation, and credential management happen on `adminHost`, which is also the `rpId`. Sessions live in the control plane, so one sign-in covers every site in the admin.

A signed-in user on a public site page (for example, a member-only post) gets a site-scoped session through a short-lived, single-use handoff token issued by `adminHost` and redeemed on the site's hostname. Without a handoff, public pages render as anonymous.

OAuth providers and Cloudflare Access keep working; their callback URLs point at `adminHost`.

### Role resolution

`locals.user.role` becomes the effective role for the current site:

```text
effectiveRole(user, site) =
  siteOverride(site, user) ?? orgMembership(site.org, user)?.role ?? none
```

A user with no membership in the site's organization gets 403 on every `/_emdash` route for that site. The auth middleware computes the effective role once per request; routes keep calling `requirePerm` and `requireOwnerPerm` unchanged. Ownership checks (`author_id`) keep working because user IDs are global.

Organization management uses new permissions in `rbac.ts`, evaluated against the organization role:

| Permission    | Minimum role |
| ------------- | ------------ |
| `org:read`    | `EDITOR`     |
| `org:members` | `ADMIN`      |
| `org:sites`   | `ADMIN`      |

API tokens gain an optional `site_id` and `org_id`. A token without them is valid only on the default site, which matches its meaning today.

### Background work

Cron tasks, scheduled publishing, cleanup, and media usage indexing are per-site work. The scheduled handler iterates active sites and runs maintenance for each under that site's request context, in bounded batches. Site database migrations run per site on first access, using the existing migration lock in that site's database.

### Admin UI

- A site switcher in the header lists sites the user can reach, grouped by organization.
- Organization screens list sites and members and edit roles and per-site overrides.
- A screen registers a site: name, slug, hostnames, database reference, and storage reference.

All strings go through Lingui and layouts use logical Tailwind classes.

### API

New routes under `/_emdash/api/orgs/` follow the existing conventions: thin route files over handlers returning `ApiResult<T>`, `parseBody` with Zod, cursor pagination, and `X-EmDash-Request` on writes.

## Compatibility and migration

Multi-site is additive and opt-in. Without `sites`, no new table, middleware step, or query exists.

Turning it on for an existing deployment:

1. Control-plane migrations create the tables.
2. A one-time import copies `users`, `credentials`, and API tokens from the default site database into the control plane, creates one organization and one site for the default database, and creates a membership for each user with the user's current role. The import is idempotent and resumable.
3. Site databases keep their `users` table. Content keeps `author_id` values, which still match because the import preserves user IDs.

Rollback: removing `sites` returns the deployment to single-site mode on the default database. Users created after the switch exist only in the control plane and do not appear on the default site after rollback.

## Security and privacy

- **Site isolation** rests on database separation, not query filters. A request can reach only the database chosen by hostname or by a verified site selection on `adminHost`.
- **Cross-site authorization:** every `/_emdash` request recomputes the effective role for the resolved site, so a session from site A carries no permission on site B without membership.
- **Site switching** is validated server-side; the `site` cookie is a preference, never proof of access.
- **Handoff tokens** are single use, expire within a minute, are bound to the target hostname, and are delivered with a POST to avoid leaking through referrers.
- **Host header:** unknown hostnames return 404, so a forged `Host` header cannot select a site that the hostname table doesn't list.
- **Database references** come only from organization Admins and resolve through operator-written `resolveDatabase` code.

## Performance

- Logged-out requests on a site hostname use the cached hostname map; the steady state adds no query. Filling the cache after a cold start costs one control-plane query per isolate, which this RFC proposes as the only accepted addition.
- Signed-in admin requests add a control-plane read for the session user's effective role, combined into the existing user lookup.
- Per-site caches multiply memory by the number of active sites in an isolate. The design caps per-site caches with LRU eviction.
- `pnpm query-counts` gains a multi-site fixture.

## Failure handling

- Control plane unreachable: site hostnames already in the cache keep serving logged-out pages; signed-in requests fail closed with 503.
- Site database unreachable or migrating: that site returns 503; other sites are unaffected.
- A failed import step logs its position and resumes on the next start.

## Verification

- Unit tests for hostname normalization and effective-role resolution.
- Integration tests on SQLite and PostgreSQL (`describeEachDialect`): two sites, one organization, membership changes, per-site overrides, cross-site access denied.
- workerd tests for D1 per-site bindings, Durable Object SQLite, and per-site cron.
- Import tests on a populated single-site database, including retry after partial completion.
- Playwright tests for the site switcher and organization screens in English and Arabic.
- Query-count snapshots showing no logged-out increase.

## Rollout and implementation

1. Control-plane schema, migrations, and the `sites` config option, hidden behind the option.
2. Site resolution middleware and per-site caches.
3. Identity on `adminHost`, effective roles, and the handoff flow.
4. Background work per site.
5. Admin UI and organization API.
6. Single-site import and documentation.

Each slice is an implementation PR that leaves single-site behavior unchanged.

## Alternatives

- **One shared database with `org_id` and `site_id` on every table.** Every content table, index, and query changes, and a single missing filter leaks content between sites. Migrating existing `ec_*` tables touches all content. Rejected.
- **Separate deployments with Cloudflare Access `roleMapping`.** Works today without code changes, but applies one role across all sites, requires Cloudflare Access, and doesn't serve Node.js deployments or give per-site overrides.
- **Separate deployments with a shared external identity service.** Moves the problem out of EmDash and leaves role management per site.

## Drawbacks

- Two databases in every signed-in request, and a new control-plane dependency on each deployment that turns this on.
- Every deployment-wide cache must become site-aware, which is a broad audit across core.
- Sign-in moves to one admin hostname, which changes the admin URL for existing sites that turn this on.

## Open questions

- Is a per-site role override needed, or is one organization role enough?
- Should one user belong to several organizations, and should an organization Admin see users who belong only to other organizations?
- Should plugin activation be per site or per deployment?
- Should site creation be able to provision databases (D1 API, PostgreSQL schemas), or stay operator-provisioned?
- Is the handoff flow needed, or can public pages on site hostnames stay anonymous?
