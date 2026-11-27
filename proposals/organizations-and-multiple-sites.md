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
- **Off by default.** A deployment without the `multiSite` option runs as a single site, exactly as it does today.

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

`emdash()` gains an optional `multiSite` option. When it is absent, nothing in this RFC runs.

```ts title="astro.config.mjs"
emdash({
	database: d1({ binding: "DB" }),
	storage: r2({ binding: "MEDIA" }),
	multiSite: {
		controlPlane: { binding: "CONTROL_DB" },
		databases: { "brand-a": { binding: "DB_BRAND_A" } },
		storages: { "brand-a": { binding: "MEDIA_BRAND_A" } },
	},
});
```

- `controlPlane` holds adapter options merged over `database`'s options, so the control plane uses the same adapter as the sites.
- `databases` and `storages` name the site databases and storage locations, as options merged over `database` and `storage`. A site row stores one of these names. The name `default` means the top-level options unchanged, which keeps existing content reachable when a deployment turns multi-site on.
- The options are plain data because `emdash()` serializes its config into the build. Keeping the list in the config also means an organization Admin can only attach a database or storage location that the operator configured, never an arbitrary path or binding.
- `hostRefreshMs` (default 30 seconds) sets how long a worker serves its cached hostname table before refreshing it in the background.

### Control-plane data model

Migrations for the control plane run from their own migration set, separate from site migrations.

| Table                         | Columns                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `_emdash_orgs`                | `id`, `slug` (unique), `name`, `created_at`, `updated_at`                           |
| `_emdash_sites`               | `id`, `org_id`, `slug`, `name`, `database_ref`, `storage_ref`, `status`, timestamps |
| `_emdash_site_hosts`          | `hostname` (primary key, lower-case), `site_id`, `is_primary`                       |
| `_emdash_org_members`         | `org_id`, `user_id`, `role`, `created_at`; primary key `(org_id, user_id)`          |
| `_emdash_site_role_overrides` | `site_id`, `user_id`, `role`; primary key `(site_id, user_id)`                      |

The control plane is also a complete EmDash database: its `users`, `credentials`, `auth_tokens`, and OAuth tables hold the accounts people sign in with. Foreign key columns are indexed.

### Site resolution

A new middleware step runs after runtime init and before setup and auth:

1. Normalize the request hostname to lower case without a port.
2. Look up `_emdash_site_hosts` through a deployment-wide cache stored on `globalThis` under a `Symbol.for` key, refreshed on a version stamp the same way site settings are.
3. On a hit, get or start that site's runtime, which owns the site's database, storage, plugins, hooks, and cron, and run the rest of the request with the site's ID and database in the request context.
4. On `adminHost`, use the site the user selected (a `site` cookie, checked against membership on every request).
5. On a miss, return 404 without touching any site database.

Each site has its own runtime. Caches that live outside the runtime (site settings, redirects, URL patterns, taxonomy definitions, collection slugs, byline fields, schemas, secrets, and the setup flag) keep one slot per site ID, and the default site keeps the slot a single-site deployment uses. Sites other than the default skip the object cache until its keys and epochs carry the site ID.

### Identity and passkeys

WebAuthn binds a passkey to one registrable domain, so a passkey created on `brand-a.com` cannot sign in on `brand-b.com`. `multiSite.adminUrl` names one admin host, which is also the `rpId`. The admin host runs on the control-plane database, migrated like any EmDash database, so its existing setup, passkey, magic-link, OAuth, and invite flows hold every account, credential, and session. One sign-in covers every site in the admin.

On the admin host:

- Sign-in, account, and setup routes (`/_emdash/api/auth/*` except `/auth/me`, `/_emdash/api/setup*`, `/_emdash/admin/setup`) and anything outside `/_emdash` run against the control plane.
- Other admin and API requests from a signed-in user run as the site they manage: the one named by `?site=` on an admin page or remembered in the `emdash-site` cookie, when the user can reach it, otherwise the first site they can reach. Access is checked on every request; the cookie only records a preference.
- Before such a request runs, the user's account is copied into the site's `users` table under the same id, with the role they hold on that site. Revisions, bylines, comments, entry locks, and the auth middleware read users from the site's own database, so they work unchanged. A site with a separate account under the same email gets `409 ACCOUNT_CONFLICT` instead of a merge.
- A site that has never been opened is marked set up, with its name as the title, so the admin skips the first-run wizard.

On a site's own hostname, `/_emdash/admin` redirects to the admin host with that site selected, and `/_emdash/api/auth/*` and `/_emdash/api/setup*` return 404, so accounts are only created and signed in on the admin host.

A signed-in user opens a site's own hostname signed in, for visual editing and previews, through a handoff: the admin issues a single-use token, valid for 60 seconds and bound to one site, from a `POST` that carries `X-EmDash-Request`. The site shows a page naming itself and redeems the token only from that page's own `POST`, whose `Origin` must be the site, then starts the site's session. A link alone can't sign anyone in as another account. Without a handoff, public pages render as anonymous.

Every signed-in or token request on a site's own hostname rechecks the user's role against the control plane before it trusts the site's copy of their account. A removal or role change takes effect on the next request everywhere, including for API tokens; a copy whose account lost access is disabled. API requests through the admin host name their site in the `X-EmDash-Site` header.

OAuth providers and Cloudflare Access keep working; their callback URLs point at the admin host.

### Role resolution

`locals.user.role` becomes the effective role for the current site:

```text
effectiveRole(user, site) =
  deploymentAdmin(user) ? ADMIN
  : siteOverride(site, user) ?? orgMembership(site.org, user)?.role ?? none
```

A deployment Admin is a user whose role in the control plane is Admin; the first account created on the admin host is one. A user with no membership in the site's organization can't select the site. Routes keep calling `requirePerm` and `requireOwnerPerm` unchanged, against the role copied into the site. Ownership checks (`author_id`) keep working because user ids are the same everywhere.

Organization management uses new permissions in `rbac.ts`. `orgs:read` and `orgs:members` are checked against the member's organization role; `orgs:create` and `sites:manage` need a deployment Admin, because a site is attached to databases the operator configured.

| Permission     | Minimum role |
| -------------- | ------------ |
| `orgs:read`    | `SUBSCRIBER` |
| `orgs:members` | `ADMIN`      |
| `orgs:create`  | `ADMIN`      |
| `sites:manage` | `ADMIN`      |

API tokens and OAuth tokens stay in each site's database: a token created while managing a site works on that site's hostname, or on the admin host with `X-EmDash-Site`, and is rechecked against the control plane on every request.

### Background work

Cron tasks, scheduled publishing, cleanup, and media usage indexing are per-site work. On Cloudflare, `runScheduledTasks()` runs each active site in turn under that site's request context. On Node, one deployment-wide timer runs `runScheduledTasks()` for every active site each minute, so a site with no traffic still publishes on time; site runtimes start no timers of their own. Site database migrations run per site on first access, using the existing migration lock in that site's database.

### Admin UI

The manifest reports `multiSite: { siteId }` on the admin host.

- A site switcher in the header lists sites the user can reach, grouped by organization.
- Organization screens list sites and members and edit roles and per-site overrides.
- A screen registers a site: name, slug, hostnames, database reference, and storage reference. Only databases other than the control plane's are offered.
- **Import accounts** copies a site's existing accounts into the control plane under the same ids, with their site roles as organization roles, for a site that ran on its own before.
- **View Site** opens the managed site's hostname signed in, through the handoff.

All strings go through Lingui and layouts use logical Tailwind classes.

### API

Routes under `/_emdash/api/multisite/` answer on the admin host and follow the existing conventions: thin route files over handlers returning `ApiResult<T>`, `parseBody` with Zod, and `X-EmDash-Request` on writes. Lists are bounded by an organization, so they return `{ items }` without a cursor.

| Route                                                                   | Who                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GET sites`                                                             | Signed-in users: sites they can switch to                      |
| `GET, POST orgs`                                                        | Members list their organizations; deployment Admins create one |
| `GET, PATCH orgs/:orgId`                                                | Members read it; organization Admins rename it                 |
| `POST orgs/:orgId/sites`, `PATCH sites/:siteId`, `GET refs`             | Deployment Admins                                              |
| `POST orgs/:orgId/members`, `PATCH, DELETE orgs/:orgId/members/:userId` | Organization Admins; an organization always keeps one Admin    |
| `DELETE orgs/:orgId/invites/:email`                                     | Organization Admins                                            |
| `PUT, DELETE sites/:siteId/roles/:userId`                               | Admins of the site's organization                              |
| `POST sites/:siteId/import-accounts`                                    | Deployment Admins                                              |
| `POST handoff`                                                          | Signed-in users, for a site they can reach                     |

Adding a member whose email has no account records an invitation, which becomes a membership when a verified account with that email signs in on the admin host.

## Compatibility and migration

Multi-site is additive and opt-in. Without `multiSite`, no new table, middleware step, or query exists.

Turning it on for an existing deployment:

1. Control-plane migrations create the tables.
2. A one-time import copies `users`, `credentials`, and API tokens from the default site database into the control plane, creates one organization and one site for the default database, and creates a membership for each user with the user's current role. The import is idempotent and resumable.
3. Site databases keep their `users` table. Content keeps `author_id` values, which still match because the import preserves user IDs.

Rollback: removing `multiSite` returns the deployment to single-site mode on the default database. Users created after the switch exist only in the control plane and do not appear on the default site after rollback.

## Security and privacy

- **Site isolation** rests on database separation, not query filters. A request can reach only the database chosen by hostname or by a verified site selection on `adminHost`.
- **Cross-site authorization:** every `/_emdash` request recomputes the effective role for the resolved site, so a session from site A carries no permission on site B without membership.
- **Site switching** is validated server-side; the `site` cookie is a preference, never proof of access.
- **Handoff tokens** are single use, expire within a minute, are bound to the target hostname, and are delivered with a POST to avoid leaking through referrers.
- **Host header:** unknown hostnames return 404, so a forged `Host` header cannot select a site that the hostname table doesn't list.
- **Database references:** organization Admins choose a site's database and storage only by name from `multiSite.databases` and `multiSite.storages`. A name the config doesn't list is refused, so a site row can't point a request at an arbitrary file path, binding, or bucket.

## Performance

- Logged-out requests on a site hostname use the cached hostname map; the steady state adds no query. Filling the cache after a cold start costs one control-plane query per isolate, which this RFC proposes as the only accepted addition.
- Signed-in admin requests add a control-plane read for the session user's effective role, combined into the existing user lookup.
- Per-site caches and runtimes multiply memory by the number of sites a worker serves. A site that serves no request for `idleSiteTtlMs` (default 10 minutes on serverless hosts) is released: its runtime, connection, storage adapter, and cache slots.
- The object cache partitions keys, epochs, and change markers by site.
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
