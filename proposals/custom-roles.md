---
title: Custom roles and collection-scoped permissions
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3717
created: 2026-10-12
---

# Custom roles and collection-scoped permissions

## Summary

A site can define its own roles from the existing permissions and limit a role's content permissions to chosen collections. The five built-in roles, their levels and every permission name stay as they are. On a site that defines no custom role, the built-in roles hold exactly the permissions they hold today, and no request issues an additional query.

The work has three phases:

1. **One authorization path.** Every role check in REST routes, MCP tools and the admin goes through the permission map, and the admin receives the signed-in user's effective permissions instead of deriving them from the role number. This phase changes no data model and is useful without the other two.
2. **Roles as data.** A roles table, collection scope for content permissions, and an API, a CLI command and a seed section for roles.
3. **Role editor.** A permission matrix in the admin.

[#824](https://github.com/emdash-cms/emdash/discussions/824) asks for "user A can edit posts in collection X but not Y". This RFC answers that request and replaces the per-collection `min_role` I proposed in a comment there.

## Problem and user case

### The admin and the server decide separately

`packages/auth/src/rbac.ts` maps 51 permission names to a minimum role level, and a check is `user.role >= Permissions[permission]`. `AGENTS.md` states that authorization is permission-based and that this map is authoritative. Most REST routes follow that rule. Four areas compare the role number instead:

- **User management.** The routes for users, invites, allowed signup domains, API tokens and OAuth clients compare the caller's role to `Role.ADMIN`, in 19 checks across 12 route files. Seven permissions in the map are never checked by core, among them `users:read` and `users:invite`, and `users:manage` is checked in one settings route.
- **MCP.** The MCP server calls `requireRole` with a role level at 53 call sites, next to the permission names that the matching REST routes use. The two can drift apart, and [#3433](https://github.com/emdash-cms/emdash/pull/3433) fixed one such case in `content_duplicate`.
- **Visual editing.** The middleware that enables edit mode on site pages compares `user.role >= 30`, and the toolbar script makes the same comparison on the role number from `/auth/me`.
- **Admin.** `GET /_emdash/api/auth/me` returns the role number and no permissions, and the admin package does not depend on `@emdash-cms/auth`. The admin declares 26 numeric role constants in 13 files and decides what to show by comparing against them.

Open reports follow from that split:

- [#1132](https://github.com/emdash-cms/emdash/discussions/1132): a Subscriber sees the collections, plugin pages, settings pages and delete buttons, and the API then rejects the actions.
- [#3034](https://github.com/emdash-cms/emdash/discussions/3034) and [#3033](https://github.com/emdash-cms/emdash/issues/3033): plugin pages are listed for every role, while a plugin route without a `permission` requires `plugins:manage`.
- The entry editor loads the users list for the author picker when the role is Editor or higher, and `GET /_emdash/api/admin/users` refuses everyone below Admin.

The Contributor role showed the same split: a Contributor could create an entry (201) and was refused on the next save (403), because the map grants `content:create` from Contributor and `content:edit_own` from Author. [#4133](https://github.com/emdash-cms/emdash/pull/4133) closed that gap with a new `content:edit_own_drafts` permission at Contributor; the admin still learns about it only through the role number.

### Five levels cannot express the requests

Each level holds every permission of the levels below it, and every content permission applies to every collection. Two kinds of request fall outside that:

- **A permission without the rest of its level.** [#2332](https://github.com/emdash-cms/emdash/issues/2332) asks for a Subscriber who can also edit byline information, and names custom roles as one way to get there.
- **A permission for some collections only.** #824 asks for users who can edit one collection and not another. [#2317](https://github.com/emdash-cms/emdash/discussions/2317) describes a site with more than twenty collections and a role for external users, and patches the sidebar to simplify the view for that role.

For a person who should edit only the job postings, the built-in roles offer two answers: a role that can edit every collection, or a second site.

## Example

A site has `posts`, `pages` and `jobs` collections. One person maintains the job postings and should edit and publish entries in `jobs` and nothing else. The seed file declares a role for that person:

```json title=".emdash/seed.json"
{
	"version": "1",
	"roles": [
		{
			"slug": "jobs-editor",
			"label": "Jobs editor",
			"permissions": ["media:read", "media:upload", "taxonomies:read"],
			"collections": {
				"jobs": [
					"content:read",
					"content:read_drafts",
					"content:create",
					"content:edit_any",
					"content:delete_any",
					"content:publish_any"
				]
			}
		}
	]
}
```

A user with this role gets these results:

| Request                                         | Result  |
| ----------------------------------------------- | ------- |
| `POST /_emdash/api/content/jobs`                | 201     |
| `POST /_emdash/api/content/jobs/{id}/publish`   | 200     |
| `GET /_emdash/api/content/posts`                | 403     |
| `PUT /_emdash/api/content/posts/{id}`           | 403     |
| MCP `content_update` with `collection: "posts"` | refused |
| `POST /_emdash/api/menus`                       | 403     |

The admin sidebar lists Jobs as the only collection for this user. `GET /_emdash/api/auth/me` returns the effective permissions:

```json
{
	"id": "01JZ3W9Q0V5T8K2M4N6P7R8S9T",
	"email": "sam@example.com",
	"name": "Sam",
	"role": 10,
	"customRole": {
		"id": "01JZ3WB4Y2D6F8H0J2K4M6N8P0",
		"slug": "jobs-editor",
		"label": "Jobs editor"
	},
	"permissions": ["media:read", "media:upload", "taxonomies:read"],
	"collections": {
		"jobs": [
			"content:read",
			"content:read_drafts",
			"content:create",
			"content:edit_own",
			"content:edit_own_drafts",
			"content:edit_any",
			"content:delete_own",
			"content:delete_any",
			"content:publish_own",
			"content:publish_any"
		]
	},
	"avatarUrl": null,
	"isFirstLogin": false
}
```

`role` holds the compatibility level, described under [Compatibility level](#compatibility-level). The `_own` permissions in `collections` come from the rule that an `_any` grant includes its `_own` counterpart, and `content:edit_own_drafts` from the rule that `content:edit_own` includes it.

The request in #2332 becomes a role with the ten Subscriber permissions and `bylines:manage`.

## Goals

- A site can define a role that holds a chosen subset of the existing permissions.
- A role can hold content permissions for chosen collections and is refused in all others, identically through REST, MCP and the admin.
- The admin decides what to show from the permissions the server sent. It holds no role thresholds of its own.
- REST and MCP evaluate the same permission for the same operation.
- An anonymous request loads no role and issues no additional query. A request from a user with a built-in role issues no additional query. A request from a user with a custom role issues no additional round trip.
- The five built-in roles hold exactly the permissions they hold today.
- Installed plugins, issued tokens and configured identity-provider mappings keep working unchanged.
- Every schema change is additive, and a version deployed before the change keeps working against the expanded schema.

## Non-goals

- **Public member accounts.** Reader, commenter and paying-subscriber accounts, open signup and paywalls belong to [#590](https://github.com/emdash-cms/emdash/discussions/590), [#1315](https://github.com/emdash-cms/emdash/discussions/1315) and [#1467](https://github.com/emdash-cms/emdash/discussions/1467). This RFC covers the people who work in the admin.
- **Multi-tenancy and organizations.** Site isolation and organization-scoped content belong to [#139](https://github.com/emdash-cms/emdash/discussions/139) and [#3079](https://github.com/emdash-cms/emdash/discussions/3079).
- **Field-level permissions.** [Security and privacy](#security-and-privacy) explains why.
- **Row-level rules beyond own and any.** No filter language and no policy documents.
- **Per-entry access.** Giving one person access to one entry is the subject of [Co-owners](https://github.com/emdash-cms/emdash/discussions/4132). This RFC keeps the ownership test as an input to the check, so a co-owner model can widen who counts as an owner without changing grants.
- **Plugin-defined permissions.** Core owns the set of permission names. A plugin route keeps naming a core permission ([#1587](https://github.com/emdash-cms/emdash/discussions/1587)).
- **Approval workflows.** A role without a publish permission cannot publish, which the existing permissions already express.
- **Changing the built-in roles.** They cannot be edited or removed, and no permission is renamed.
- **Deny rules.** Roles only grant.

## Detailed design

### Terms

| Term       | Meaning                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Permission | A name from the map in `rbac.ts`, such as `content:edit_own`. Core owns the set.                                  |
| Grant      | A permission held by a role, either for all collections (unscoped) or for a list of collection slugs (scoped).    |
| Role       | A named set of grants. The five built-in roles are defined by the map. A custom role is a row in `_emdash_roles`. |
| Actor      | The signed-in user together with the grants of the user's role. Every check receives an actor.                    |
| Scopable   | A permission that can be granted per collection: every `content:*` permission, and `editorial:*` once it exists.  |

### Check

The existing helpers in `@emdash-cms/auth` decide, with an optional resource:

```ts
hasPermission(actor: Actor | null, permission: Permission, resource?: { collection?: string }): boolean
canActOnOwn(actor: Actor | null, ownerId: string, own: Permission, any: Permission, resource?: { collection?: string }): boolean
```

- A missing actor is a denial.
- For a built-in role, the answer is `actor.role >= Permissions[permission]`, as today.
- For a custom role, the answer comes from its grants. An unscoped grant satisfies any check of that permission. A scoped grant satisfies a check only when `resource.collection` is one of its collections. A check that names no collection is satisfied only by an unscoped grant.
- A grant of an `_any` permission includes the matching `_own` permission in the same scope, for content and media, a grant of `content:edit_own` includes `content:edit_own_drafts` in the same scope, and a grant of a `manage` permission includes the matching `read` permission (taxonomies, menus, bylines, widgets, sections, redirects and search; `comments:moderate` includes `comments:read`). Inclusions chain. The built-in ladder gives every role these pairs; a custom role gets them from this rule.
- Ownership stays a separate helper with its rules, including the rule that an empty owner id matches nobody. A co-owner model can widen who counts as an owner there without touching grants.
- An unknown role reference yields no grants. Unknown permission names in a stored role are dropped when the grants are read.

`requirePerm`, `requireOwnerPerm`, `requireAnyPerm`, `entryEditAccess` and `requireEntryEditPerm` in core gain the same optional resource. Helpers for navigation and cross-collection reads answer "in which collections does the actor hold this permission", with `null` meaning all. The MCP server's internal `requireRole` helper is removed.

### Data model

One new system table:

| Column        | Type               | Notes                                                                             |
| ------------- | ------------------ | --------------------------------------------------------------------------------- |
| `id`          | `text` primary key | ULID                                                                              |
| `slug`        | `text` unique      | `/^[a-z][a-z0-9_-]*$/`, at most 63 characters, not one of the five built-in slugs |
| `label`       | `text`             | Display name                                                                      |
| `description` | `text` nullable    |                                                                                   |
| `grants`      | `text` (JSON)      | `{ "permissions": string[], "collections": { [slug]: string[] } }`                |
| `created_at`  | `text`             | `datetime('now')` default                                                         |
| `updated_at`  | `text`             | `datetime('now')` default                                                         |

Three existing tables gain a nullable reference to `_emdash_roles.id`, each with a foreign key and an index:

| Table             | New column        | Meaning                                                           |
| ----------------- | ----------------- | ----------------------------------------------------------------- |
| `users`           | `role_id`         | The user's custom role. `NULL` means the built-in role in `role`. |
| `auth_tokens`     | `role_id`         | The custom role an invite assigns.                                |
| `allowed_domains` | `default_role_id` | The custom role a self-signup from that domain receives.          |

When a reference is set, the level column next to it (`users.role`, `auth_tokens.role`, `allowed_domains.default_role`) holds the role's compatibility level. One function derives the level from the role row. Every write that sets a reference, and every role update, rewrites the affected levels atomically, so code that does not know custom roles reads a valid level. The role row stores no level of its own.

### Loading the role

The user lookups in the Kysely auth adapter (`getUserById`, which the auth middleware runs on every request with a session or token, `getUserByEmail`, which it runs under Cloudflare Access, and `getUserWithDetails` and `getUsers`) gain a `LEFT JOIN _emdash_roles ON users.role_id = _emdash_roles.id`. The grants arrive with the user row in the same query. Anonymous requests run no user lookup and therefore load no role. For built-in roles the join finds no row and the check reads the map.

The join requires the migration. The runtime's `auto` mode applies it, and `check` mode answers 503 before serving a request while it is pending. A `manual` deployment can serve the new build before the migration has run. For that window, the adapter catches the error for a missing `_emdash_roles` table or a missing `role_id` column, falls back to the plain `users` select and retries the join a minute later. Until the migration runs, every user acts with the built-in role in `users.role`, instead of every sign-in failing. The fallback costs nothing once the table exists.

An edited role applies on the user's next request, because the role row is read with the user row every time. The admin caches `/auth/me` for five minutes, so another open admin session shows its old navigation until then.

### Compatibility level

Code that reads the integer keeps working: third-party plugins, `minRole` on plugin panels and list columns, and a version deployed before the migration. For a custom role, the level is the highest built-in level whose permissions the role holds unscoped. A role that contains no built-in role gets 10 (Subscriber), because `toRoleLevel` accepts only the five values.

| Custom role                               | Compatibility level |
| ----------------------------------------- | ------------------- |
| Editor permissions without `menus:manage` | 30 (Author)         |
| `byline-editor` from the example          | 10 (Subscriber)     |
| `jobs-editor` from the example            | 10 (Subscriber)     |

Code that reads only the integer never grants more than the role holds, with two exceptions. A role narrower than Subscriber, such as `jobs-editor`, appears to that code as a Subscriber, which can read published content in every collection. A level stored before a release added a permission at or below it stays until the role's next update. [Open questions](#open-questions) asks about both.

### Effective permissions in the admin

`/auth/me` gains three fields for every user, built-in roles included:

| Field         | Type                                                  | Content                                                                                                       |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `customRole`  | `{ id: string; slug: string; label: string } \| null` | The custom role, or `null` for a built-in role                                                                |
| `permissions` | `string[]`                                            | Unscoped permissions, with the permissions they include added; for a built-in role, every permission it holds |
| `collections` | `Record<string, string[]>`                            | Scoped permissions per collection slug, with the same addition; `{}` for a built-in role                      |

`role` stays and holds the level. The admin gets `useCan(permission, { collection })`, which reads these fields and replaces the numeric comparisons in the sidebar, the command palette, route guards and action buttons. A route guard that fails shows an access-denied state, as the comments and byline schema pages do today, instead of a blank screen. The server stays the security boundary: the payload only keeps the admin from offering what the server refuses.

### Content routes, lists and MCP

Content routes take the collection from the URL. The revision routes and bulk tagging have no collection in the URL and take it from the loaded revision or from each item. Collection scope needs no row filter: a list request for a collection the role may not read is refused before the query runs.

Every content route checks that the actor holds some content permission in the URL's collection before it loads the entry. Without that check, a role could tell a missing entry (404) from an existing one it may not touch (403) in a collection it cannot reach. Every built-in role passes it.

Reads that cross collections apply the scope per collection:

- The dashboard, the calendar, draft search in REST and search in MCP drop collections the actor may not read from the query. An empty result short-circuits, because the search layer treats an empty collection list as all collections. The dashboard shows drafts and policy rejections only in collections where the actor holds `content:read_drafts`.
- Reference routes return rows from the other side of the relation, so they check read and draft access on that collection, not on the URL's.
- Reference fields that point into another collection resolve on the entry read with the actor's `content:read` and `content:read_drafts` in the target collection, and resolve to an empty list when the actor cannot read it. A write that selects or keeps a reference is refused unless the actor holds `content:read` in the target collection.
- Revision routes answer 404, not 403, for a revision in a collection whose drafts the actor may not read.

The permission a route checks must govern everything its response contains and everything its write touches. Several routes today check one name and return data that another name governs, relying on the built-in ladder to hold both. A custom role can hold one name without the other, so phase 2 checks each route against this rule.

Entries are scoped; collection schemas are not. The admin manifest shows every collection's name, fields and taxonomies to every admin user, because the admin needs them to render, and `GET /_emdash/api/schema/collections` shows them to every holder of `schema:read`. The sidebar and the command palette list only the collections the actor holds a content permission in.

MCP tools call the same helpers with the same permission names as their REST counterparts and pass the tool's `collection` argument. Read tools that check no permission today get the Subscriber-level permission of their REST counterpart, which changes nothing for built-in roles. Where a tool's role level differs from the REST permission today, such as `media_create`, phase 1 settles each difference on its own, with the REST permission as the default.

### Plugins

The plugin route contract does not change. A route names a core permission and defaults to `plugins:manage`. The dispatcher passes the actor, so a custom role that holds the named permission can call the route. On the entry editor's extension route (`content/{collection}/{id}/plugin-extensions/…`), the host passes the collection from its own route, after checking it against the extension's collection list and loading the entry from it, so a scoped grant can satisfy that route. The plugin's request body never supplies the collection. The general plugin route has no trusted collection, so only an unscoped grant satisfies it. `ctx.user.role` in plugin routes and `actor.role` in content hooks carry the compatibility level.

A plugin route runs with the plugin's capabilities, not with the caller's grants: the plugin context is built per plugin, and a plugin that reads or writes content through its capabilities reaches every collection. The permission on the route decides who may call it; what the route then does is bounded by the plugin. A policy hook that compares `actor.role` therefore sees a `jobs-editor` as a Subscriber.

Plugin pages, dashboard widgets and sandboxed editor panels are offered to every role today and gated only by their routes; trusted editor panels and list columns compare `minRole` with the level. Phase 1 makes plugin pages, dashboard widgets and sandboxed editor panels visible by permission. Trusted editor panels and list columns keep `minRole`, compared with the compatibility level. Whether visibility comes from the backing route or from a field on the page is the open decision in #3034; this RFC requires only that it is a permission name.

### Tokens

Effective access stays the token's scopes intersected with the role's permissions. For a custom role, the allowed scopes are derived from its grants: a scope is offered when the role holds its permission unscoped or in at least one collection, and checks still apply the collection scope. `admin` and `mcp:tools` are never offered to a custom role. Approval in the device flow and the authorization-code flow, the code exchange and the refresh all clamp scopes with the actor's grants. Built-in roles keep `scopesForRole` unchanged. Personal API tokens and OAuth clients stay managed by the built-in Admin role, through the Admin-level permissions phase 1 adds for them.

### Visual editing

Edit mode on site pages requires `content:edit_own` and `content:read_drafts`, both unscoped, because edit mode serves drafts in every collection. The middleware and the toolbar script both check these names instead of `role >= 30`; the toolbar reads them from `/auth/me`. Built-in roles get the same result as today. A scoped role gets no edit mode.

### Identity providers

`roleMapping` and `defaultRole` in the Cloudflare Access configuration and `defaultRole` in the Atmosphere configuration accept a role slug in addition to a number. A slug that names no role at sign-in falls back to Subscriber and is logged with the `[auth]` prefix. Role sync in the Cloudflare Access configuration (`syncRoles`) leaves a user who holds a custom role untouched: a level from the provider applies to built-in roles only, and the provider assigns a custom role only through a slug.

### Managing roles

Managing roles is user management: listing and reading roles require `users:read`, and writes require `users:manage`. A custom role cannot hold a reserved permission:

| Reserved permission                                                       | Reason                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `users:read`, `users:invite`, `users:manage`, `auth:manage_connections`   | They decide who may sign in and with which role.                                                                                    |
| `settings:manage`                                                         | It sets the Site URL that magic-link, invite and recovery links are built from when neither `siteUrl` nor `EMDASH_SITE_URL` is set. |
| `plugins:manage`                                                          | It installs plugins and writes their settings; an installed email plugin delivers sign-in links when no other provider is active.   |
| `schema:manage`                                                           | It alters and deletes collections the role may not read.                                                                            |
| `import:execute`, `transfer:import`                                       | They write content in every collection.                                                                                             |
| `backups:manage`, `transfer:export`                                       | They read every collection.                                                                                                         |
| The Admin-level permissions phase 1 adds for API tokens and OAuth clients | They issue credentials.                                                                                                             |

A write that includes a reserved permission is rejected. `content:delete_permanent` (scopable), `comments:delete`, `comments:settings`, `redirects:manage`, `search:manage` and `updates:read` stay grantable.

| Method and path                          | Purpose                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /_emdash/api/admin/roles`           | `{ items }` of built-in and custom roles; built-in ones are read-only                                                                            |
| `POST /_emdash/api/admin/roles`          | Create from `{ slug, label, description?, permissions, collections }`                                                                            |
| `GET /_emdash/api/admin/roles/{slug}`    | One role                                                                                                                                         |
| `PUT /_emdash/api/admin/roles/{slug}`    | Replace label, description and grants; the slug is immutable                                                                                     |
| `DELETE /_emdash/api/admin/roles/{slug}` | Delete a role that no user, unexpired invite or allowed domain references; expired invites that reference it are removed in the same transaction |

Every route returns these error codes:

| Code               | When                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR` | Invalid slug, unknown permission, a non-scopable permission under `collections`, a reserved permission |
| `CONFLICT`         | The slug exists, or names a built-in role                                                              |
| `ROLE_IN_USE`      | Delete of a role referenced by a user, an unexpired invite or an allowed domain                        |
| `NOT_FOUND`        | No role with that slug                                                                                 |

Collection slugs in `collections` are not required to exist. A scope entry for a slug with no collection grants nothing; a collection created later with that slug is covered by it.

The user, invite and allowed-domain routes accept a role slug wherever they accept a level today. The existing rules stay: a user cannot change their own role, and the last-admin guard counts enabled users with the built-in Admin role.

- **CLI.** `emdash role list|get|create|update|delete`, going through the REST API like `emdash menu` and `emdash taxonomy`.
- **Seed.** `SeedFile` gains `roles?: SeedRole[]` with the shape of the create body. Applying a seed creates missing roles and updates existing ones by slug. `emdash export-seed` writes the section.

### Localization and accessibility

Permission names stay identifiers; the admin shows a translated label and description for each, and custom role labels are site data that is not translated. The matrix is a table with row and column headers, and each cell is a labelled checkbox.

## Compatibility and migration

- **Existing sites.** No step is required. Every user keeps a built-in role and `role_id` is `NULL`.
- **Migration.** One migration creates `_emdash_roles` and adds the three nullable columns and their indexes, guarded by existence checks (`ifNotExists` for the table and indexes, a column check before each `ALTER TABLE`) so it can restart after any statement. `down` drops the columns and the table.
- **Rolling deploy, old code on the new schema.** Code deployed before the migration ignores the new table and columns and reads the level. A role change made by an old version writes only `users.role`, which the new version ignores while `role_id` is set. A custom-role invite accepted by an old version creates a user with the built-in role at the stored level, and the custom role is lost. Admins should not assign custom roles until every running version knows them; the changeset says so.
- **Rollback.** An older version reads `users.role`, which holds the compatibility level, so a user with a custom role keeps at most the built-in role the custom role contains, or Subscriber.
- **Site transfer.** `_emdash_roles` is not portable, like the other auth tables, so a transfer import brings no users and no roles.
- **Public API.** `/auth/me` gains fields and changes none. The authorization helpers gain an optional argument. Identity-provider options accept a slug in addition to a number. No export is removed.
- **Behavior change for built-in roles.** Their permissions do not change. Phase 1 changes what the admin offers them, so it stops offering actions the server refuses, and settles MCP tools whose level differs from the REST permission; each such change is listed in that phase's changeset.
- **Documentation.** The role table in the authentication guide stays valid for built-in roles. A new page covers custom roles, the seed section and the compatibility level.

## Security and privacy

- **Untrusted keys.** Grants are looked up with `Object.hasOwn`, because `constructor` is a valid collection slug.
- **Privilege escalation.** Custom roles cannot hold the [reserved permissions](#managing-roles), so the compatibility level of a custom role therefore never reaches 50, and the last-admin guard never counts a custom-role user.
- **Site-wide permissions act across collections.** A collection scope applies to `content:*` permissions. Every other permission acts on the whole site by design: `bylines:manage` deleting a byline clears it from entries in every collection, `taxonomies:manage` deleting a term removes its assignments everywhere, `media:edit_any` and `media:delete_any` change files that any collection uses, `comments:moderate` reads every collection's comments with author email and IP hash, and a slug change writes the site-wide redirect table. A scoped role that holds one of these is not limited to its collections.
- **No field-level permissions.** Field read restrictions have leaked through filtering, sorting and relation traversal in other CMSs: Strapi [GHSA-rjg2-95x7-8qmx](https://github.com/strapi/strapi/security/advisories/GHSA-rjg2-95x7-8qmx), Payload [GHSA-9g87-32v6-3c2r](https://github.com/payloadcms/payload/security/advisories/GHSA-9g87-32v6-3c2r) and [GHSA-fpww-c55p-cjv6](https://github.com/payloadcms/payload/security/advisories/GHSA-fpww-c55p-cjv6). A collection scope is checked once per request and collection before any query runs, so filters, sorts and joins inside the query cannot bypass it. Reads that cross collections still have to apply it, which [Verification](#verification) covers.
- **Kept invariants.** Users without `content:read_drafts` keep receiving 404 for unpublished entries. The empty-owner rule, the last-admin guard, the ban on changing one's own role and scope clamping at token refresh stay.
- **Privacy.** No new personal data is stored. `/auth/me` returns only the caller's own permissions.

## Performance

- **Logged-out routes.** No change. Anonymous requests load no user and no role. The query-count snapshots for logged-out routes must not change.

A [prototype](https://github.com/danielmlr/emdash/tree/poc/custom-roles) ([findings](https://github.com/danielmlr/emdash/blob/poc/custom-roles/demos/custom-roles/FINDINGS.md)) measured database queries per request on a Node.js and SQLite demo site with `EMDASH_QUERY_LOG=1`, after one warm-up request per route. `jobs-editor` is the role from the example; `site-editor` is a custom role without collection scope.

| Request                         | Anonymous | Admin | Editor | Contributor | `jobs-editor` | `site-editor` |
| ------------------------------- | --------- | ----- | ------ | ----------- | ------------- | ------------- |
| `GET /`                         | 6         | 7     | 7      | 7           | 7             | 7             |
| `GET /jobs`                     | 8         | 9     | 9      | 9           | 9             | 9             |
| `GET /_emdash/api/auth/me`      | 401       | 1     | 1      | 1           | 1             | 1             |
| `GET /_emdash/api/content/jobs` | 401       | 6     | 6      | 6           | 6             | 6             |
| `GET /_emdash/api/dashboard`    | 401       | 14    | 14     | 14          | 10            | 14            |

The extra query on authenticated pages is the existing user lookup, which carries the role through the join. `jobs-editor` reads one collection on the dashboard, so it runs fewer queries. `pnpm query-counts` matches the committed logged-out snapshots for SQLite and D1 in count and query text. The per-role counts above have not been measured on D1 yet. An anonymous request to an API route is refused with 401 and has no count.

## Failure handling

- **Stored role with invalid JSON.** The role yields no grants, so every check for that user denies, and the error is logged with the `[auth]` prefix. An Admin repairs the role through the API or the editor.
- **Role row missing.** A reference to a missing role yields no grants, so every check denies until an Admin assigns a role.
- **Role update interrupted on D1.** The role update runs as one batch. If a batch is lost, the update is idempotent and saving the role again repairs the stored levels.
- **Seed with an unknown permission.** Seed validation fails before anything is written, naming the role and the permission.

## Verification

- **Equivalence.** For each built-in role and each permission, `hasPermission` returns what `role >= Permissions[permission]` returns.
- **Scope.** Route tests with a collection-scoped role cover the content routes, the routes without a collection in the URL, the 404/403 distinction in an unreachable collection, search with an empty narrowed list, the dashboard, the calendar, reference reads and writes into a collection the role may not read, and the plugin extension route.
- **Permission governs the response.** For each route, a test with a custom role that holds only the checked permission shows that the response contains nothing and the write touches nothing that another permission governs.
- **Reserved permissions.** The API, the seed and the role editor refuse each reserved permission.
- **Parity.** One table of operations drives REST and MCP tests, so both surfaces are asserted against the same permission.
- **Query counts.** The logged-out snapshots do not change. A test asserts the round trips of an authenticated content request with a built-in role and with a custom role.
- **Migration.** Upgrade from existing data, retry after a partial run, the adapter fallback before the migration, and every supported dialect with `describeEachDialect`.
- **Compatibility level.** Derivation tests, and a test that code reading only `users.role` never grants more than the custom role, apart from the two exceptions under [Compatibility level](#compatibility-level).
- **Admin.** Playwright runs the example's `jobs-editor` through the sidebar, an entry in `jobs`, and a direct URL to an entry in `posts`. The role editor is checked in Arabic.

## Rollout and implementation

| Phase | Content                                                                                                                                                                                                                                                                                                                                                               | Schema change |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1     | The optional resource on the checks and the equivalence test. Permission names replace the role comparisons in the user-management, API token and OAuth client routes, MCP and visual editing, with a new Admin-level name where none exists yet. Effective permissions in `/auth/me`. `useCan` in the admin. Plugin pages, widgets and panels visible by permission. | None          |
| 2     | `_emdash_roles` and the references. Collection scope in content routes, cross-collection reads and MCP tools. The roles API, the seed section and the CLI. Role slugs in identity-provider mappings. Token scopes derived from grants. Custom roles in the user role picker. The route audit.                                                                         | Additive      |
| 3     | The role editor: a permission matrix that starts from a built-in role as a template. Documentation.                                                                                                                                                                                                                                                                   | None          |

Each phase is a separate set of pull requests and ships without a feature flag. Phase 1 can ship on its own. I will implement phases 1 and 2.

### Reconciliation with related work

[Editorial comments](https://github.com/emdash-cms/emdash/pull/4126) adds `editorial:comment` and `editorial:manage` and names this RFC. Both permissions are scopable, because every editorial route has the collection in its path. Its mentionable-users endpoint, which it places per entry for a future collection-scoped model, lists users who hold `editorial:comment` and `content:read_drafts` in the entry's collection. If both are accepted, the second to land carries this.

## Alternatives

### One minimum role per collection

A nullable `min_role` on the collection, checked next to the permission, which I proposed on #824. It needs one column and no new concept, but it is one-dimensional: whoever passes the higher threshold also passes the lower one, so it cannot express two departments that must not edit each other's collections. It does not cover #2332 either.

### Built-in role plus a collection list

A user keeps a built-in level and gains a list of collections. This keeps roles ordered and is smaller than roles as data. It covers the collection cases and not #2332, and the first request for "Editor without one permission" would need a second migration.

### Generated permission names per collection

Drupal and Craft generate permission names per content type (`edit any $type_id content`, `saveEntries:<section uid>`). In EmDash the permission names are a closed type that installed plugins reference, so generated names would change a public contract. A scope on the grant reaches the same granularity.

### Access functions in site code

Payload and Keystone let site code decide each operation. EmDash collections are created at runtime in the admin, and roles need to be managed there too.

### Veto hooks in a site plugin

`content:beforeSave` and `content:beforePublish` receive the actor and the collection, so a site plugin can already refuse saves and publications per user and collection. That covers writes only: lists, reads and the admin still show every collection, and deletion, restore and discarding a draft run no hook that both knows the actor and can refuse.

### Policies with filters, and relationship tuples

Directus-style policies and the tuple model that #824 opens with express row-level and delegated access. Both decide per row, so every query that reads content carries their constraint. The requests in [Problem and user case](#problem-and-user-case) do not need that.

### Object cache instead of a join

Caching role rows in the object cache with invalidation on role writes avoids touching the user query. The object cache is optional and off by default, so it cannot meet the round-trip goal on every site, and an edited role would apply only after invalidation reaches the isolate.

## Drawbacks

- **New core permissions do not reach custom roles.** A built-in role receives a new permission through the map. A custom role holds what it was given, so an upgrade can leave it without access to a new feature until an Admin grants it. The editorial-comments permissions are the first instance.
- **Roles are no longer ordered.** Code and documentation that say "at least Editor" have no meaning for a custom role. Code that compares the level sees a custom role as the largest built-in role it contains, so a `minRole` on a plugin panel hides the panel from a custom role that holds the permissions behind it.

## Open questions

- **The Subscriber floor.** Should every custom role be required to contain the Subscriber permissions? That would remove the exception in the compatibility level, and it would forbid roles like `jobs-editor` that must not read other collections through the admin and API.
- **Compatibility level after an upgrade.** A permission that a release adds at or below a custom role's level is not part of that role, so the role no longer contains the level stored for its users. As designed, the stored level is kept until the role's next update. Should a release that adds a permission recompute it instead, which can lower it?
- **`search:read`.** The map defines it, but no route checks it. Should search check it, or should the role editor leave it out?
- **Own drafts only.** Every role with `content:read_drafts` sees all drafts, revisions and trashed entries of a collection. A role for external users, as in #2317, may need to see only its own entries. Leave this for a follow-up proposal?
- **Draft-only edits.** `content:edit_own_drafts` covers saving, locking and setting terms on an entry while it is a draft. Discarding a draft, restoring from the trash and duplicating still require `content:edit_own` or `content:edit_any`, as they do today for a Contributor. Should those three accept the draft-only permission too?
- **One role per user.** Several additive roles per user is the alternative.
