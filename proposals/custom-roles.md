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

`packages/auth/src/rbac.ts` maps 50 permission names to a minimum role level, and a check is `user.role >= Permissions[permission]`. `AGENTS.md` states that authorization is permission-based and that this map is authoritative. Most REST routes follow that rule. Four areas compare the role number instead:

- **User management.** The routes for users, invites, allowed signup domains, API tokens and OAuth clients compare the caller's role to `Role.ADMIN`, in 19 checks across 12 route files. Seven permissions in the map are never checked by core, among them `users:read` and `users:invite`, and `users:manage` is checked in one settings route.
- **MCP.** The MCP server calls `requireRole` with a role level at 53 call sites, next to the permission names that the matching REST routes use. The two can drift apart, and [#3433](https://github.com/emdash-cms/emdash/pull/3433) fixed one such case in `content_duplicate`.
- **Visual editing.** The middleware that enables edit mode on site pages compares `user.role >= 30`, and the toolbar script makes the same comparison on the role number from `/auth/me`.
- **Admin.** `GET /_emdash/api/auth/me` returns the role number and no permissions, and the admin package does not depend on `@emdash-cms/auth`. The admin declares 26 numeric role constants in 13 files and decides what to show by comparing against them.

Open reports follow from that split:

- [#1132](https://github.com/emdash-cms/emdash/discussions/1132): a Subscriber sees the collections, plugin pages, settings pages and delete buttons, and the API then rejects the actions.
- [#3034](https://github.com/emdash-cms/emdash/discussions/3034) and [#3033](https://github.com/emdash-cms/emdash/issues/3033): plugin pages are listed for every role, while a plugin route without a `permission` requires `plugins:manage`.

The Contributor role shows the same split. A Contributor creates an entry (201) and is refused on the next save (403), while the editor offers Save, Publish now and Schedule. The map grants `content:create` from Contributor and `content:edit_own` from Author. [#4133](https://github.com/emdash-cms/emdash/pull/4133) addresses this with a new `content:edit_own_drafts` permission; the admin still learns about it only through the role number.

### Five levels cannot express the requests

Each level holds every permission of the levels below it, and every content permission applies to every collection. Two kinds of request fall outside that:

- **A permission without the rest of its level.** [#2332](https://github.com/emdash-cms/emdash/issues/2332) asks for a Subscriber who can also edit byline information, and names custom roles as one way to get there.
- **A permission for some collections only.** #824 asks for users who can edit one collection and not another. [#2317](https://github.com/emdash-cms/emdash/discussions/2317) describes a site with more than twenty collections and a role for external users, and patches the sidebar to simplify the view for that role.

For a person who should edit only the job postings, the built-in roles offer two answers: a role that can edit every collection, or a second site.

## Example

A site has `posts`, `pages` and `jobs` collections. One person maintains the job postings and should edit and publish entries in `jobs` and nothing else. The seed file declares a role for that person:

```json title=".emdash/seed.json"
{
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
	"roleSlug": "jobs-editor",
	"permissions": ["media:read", "media:upload", "taxonomies:read"],
	"collections": {
		"jobs": [
			"content:read",
			"content:read_drafts",
			"content:create",
			"content:edit_own",
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

`role` holds the compatibility level, described under [Compatibility level](#compatibility-level). The `_own` permissions in `collections` come from the rule that an `_any` grant includes its `_own` counterpart.

The request in #2332 becomes a role with the Subscriber permissions and `bylines:manage`:

```json
{
	"slug": "byline-editor",
	"label": "Byline editor",
	"permissions": [
		"content:read",
		"media:read",
		"taxonomies:read",
		"comments:read",
		"menus:read",
		"bylines:read",
		"widgets:read",
		"sections:read",
		"search:read",
		"auth:manage_own_credentials",
		"bylines:manage"
	]
}
```

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
| Scopable   | A permission that can be granted per collection: every `content:*` permission except `content:delete_permanent`.  |

### Check

`@emdash-cms/auth` exports one function that decides:

```ts
can(actor: Actor | null, permission: Permission, resource?: { collection?: string; ownerId?: string | null }): boolean
```

- A missing actor is a denial.
- For a built-in role, the answer is `actor.role >= Permissions[permission]`, as today.
- For a custom role, the answer comes from its grants. An unscoped grant satisfies any check of that permission. A scoped grant satisfies a check only when `resource.collection` is one of its collections. A check that names no collection is satisfied only by an unscoped grant.
- A grant of an `_any` permission includes the matching `_own` permission for the same collections. `canActOnOwn` asks for the `_own` permission when the actor owns the item, and the built-in ladder guarantees this inclusion; a custom role needs it stated.
- Ownership keeps its rules, including the rule that an empty owner id matches nobody.
- An unknown role reference yields no grants. An unknown permission name in a stored role grants nothing and is logged once per isolate with the `[auth]` prefix.

`hasPermission`, `requirePerm`, `requireOwnerPerm` and `requireAnyPerm` keep their signatures, gain an optional `{ collection }` argument, and call `can`. The MCP server's internal `requireRole` helper is removed.

### Data model

One new system table:

| Column        | Type               | Notes                                                                             |
| ------------- | ------------------ | --------------------------------------------------------------------------------- |
| `id`          | `text` primary key | ULID                                                                              |
| `slug`        | `text` unique      | `/^[a-z][a-z0-9_-]*$/`, at most 63 characters, not one of the five built-in slugs |
| `label`       | `text`             | Display name                                                                      |
| `description` | `text` nullable    |                                                                                   |
| `grants`      | `text` (JSON)      | `{ "permissions": string[], "collections": { [slug]: string[] } }`                |
| `level`       | `integer`          | The compatibility level, recomputed on every write                                |
| `created_at`  | `text`             | `datetime('now')` default                                                         |
| `updated_at`  | `text`             | `datetime('now')` default                                                         |

Three existing tables gain a nullable reference, each with an index:

| Table             | New column        | Meaning                                                           |
| ----------------- | ----------------- | ----------------------------------------------------------------- |
| `users`           | `role_id`         | The user's custom role. `NULL` means the built-in role in `role`. |
| `auth_tokens`     | `role_id`         | The custom role an invite assigns.                                |
| `allowed_domains` | `default_role_id` | The custom role a self-signup from that domain receives.          |

When `role_id` is set, `users.role` holds the role's compatibility level. Every write that sets `role_id` also writes `role`, so code that does not know custom roles reads a valid level.

A user has one role. Someone who needs what two roles grant gets a third role that combines them.

### Loading the role

`getUserById` in the Kysely auth adapter, which the auth middleware runs on every authenticated request, gains a `LEFT JOIN _emdash_roles ON users.role_id = _emdash_roles.id`. The grants arrive with the user row in the same query. Anonymous requests run no user lookup and therefore load no role. For built-in roles the join finds no row and the check reads the map.

On a database where the migration has not run, the adapter selects without the join, detected through `isMissingTableError`, so a deploy that precedes the migration keeps working.

An edited role applies on the user's next request, because the role row is read with the user row every time.

### Compatibility level

Code that reads the integer keeps working: third-party plugins, `minRole` on plugin panels and list columns, and a version deployed before the migration. For a custom role, the level is the highest built-in level whose permissions the role holds unscoped. A role that contains no built-in role gets 10 (Subscriber), because `toRoleLevel` accepts only the five values.

| Custom role                               | Compatibility level |
| ----------------------------------------- | ------------------- |
| Editor permissions without `menus:manage` | 30 (Author)         |
| `byline-editor` from the example          | 10 (Subscriber)     |
| `jobs-editor` from the example            | 10 (Subscriber)     |

Code that reads only the integer never grants more than the role holds, with one exception: a role narrower than Subscriber, such as `jobs-editor`, appears to that code as a Subscriber, which can read published content in every collection. [Open questions](#open-questions) asks whether every custom role must contain the Subscriber permissions.

### Effective permissions in the admin

`/auth/me` gains three fields for every user, built-in roles included:

| Field         | Type                       | Content                                                                |
| ------------- | -------------------------- | ---------------------------------------------------------------------- |
| `roleSlug`    | `string`                   | `"admin"`, `"editor"` and so on for built-in roles, the slug otherwise |
| `permissions` | `string[]`                 | Unscoped permissions, with `_own` added for each `_any`                |
| `collections` | `Record<string, string[]>` | Scoped permissions per collection slug, with the same addition         |

`role` stays and holds the level. The admin gets `useCan(permission, { collection })`, which reads these fields and replaces the numeric comparisons in the sidebar, the command palette, route guards and action buttons. A route guard that fails shows the existing "insufficient permissions" state instead of a blank screen. The server stays the security boundary: the payload only keeps the admin from offering what the server refuses.

### Content routes, lists and MCP

Content routes take the collection from the URL. The revision routes and bulk tagging have no collection in the URL and take it from the loaded revision or from each item. Collection scope needs no row filter: a list request for a collection the role may not read is refused before the query runs.

Reads that cross collections apply the scope per collection:

- Search and the calendar drop collections the actor may not read from the query.
- Relation and reference lookups return only targets in collections the actor may read.
- The collection list (`GET /_emdash/api/schema/collections`) returns the collections the actor may read.

MCP tools call `can` with the same permission names as their REST counterparts and pass the tool's `collection` argument. Where a tool's role level differs from the REST permission today, phase 1 settles each difference on its own, with the REST permission as the default. `media_create` is one: the tool asks for Author, and the REST route that confirms the same upload asks for `media:upload`, which a Contributor holds.

### Plugins

The plugin contract does not change. A route names a core permission and defaults to `plugins:manage`. The dispatcher passes the actor, so a custom role that holds the named permission unscoped can call the route. A scoped grant never satisfies a plugin route check, because the request carries no collection the host can trust. `ctx.user.role` and `actor.role` in hooks carry the compatibility level.

Plugin pages and Block Kit editor panels become visible by permission instead of by role level. Whether visibility comes from the backing route or from a field on the page is the open decision in #3034; this RFC requires only that it is a permission name.

### Tokens

Effective access stays the token's scopes intersected with the role's permissions. `scopesForRole` derives the allowed scopes from the actor's grants instead of from a minimum level, and returns the same result as today for built-in roles. A scope whose permissions the role holds only scoped is not offered. Clamping at issuance and at refresh stays.

### Identity providers

`roleMapping` and `defaultRole` in the Cloudflare Access configuration and `defaultRole` in the Atmosphere configuration accept a role slug in addition to a number. A slug that names no role at sign-in falls back to Subscriber and is logged with the `[auth]` prefix.

### Managing roles

A new permission, `roles:manage`, sits at Admin. Custom roles cannot hold it, nor `users:read`, `users:invite` or `users:manage`. A write that includes one of them is rejected.

| Method and path                          | Purpose                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `GET /_emdash/api/admin/roles`           | `{ items }` of built-in and custom roles; built-in ones are read-only |
| `POST /_emdash/api/admin/roles`          | Create from `{ slug, label, description?, permissions, collections }` |
| `GET /_emdash/api/admin/roles/{slug}`    | One role                                                              |
| `PUT /_emdash/api/admin/roles/{slug}`    | Replace label, description and grants; the slug is immutable          |
| `DELETE /_emdash/api/admin/roles/{slug}` | Delete a role that nothing references                                 |

Every route requires `roles:manage`, validates its body with `parseBody`, and returns these error codes:

| Code               | When                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | Invalid slug, unknown permission, a non-scopable permission under `collections`, a forbidden permission |
| `CONFLICT`         | The slug exists, or names a built-in role                                                               |
| `ROLE_IN_USE`      | Delete of a role referenced by a user, an invite or an allowed domain                                   |
| `NOT_FOUND`        | No role with that slug                                                                                  |

Collection slugs in `collections` are not required to exist. A scope entry for a slug with no collection grants nothing; a collection created later with that slug is covered by it.

The user, invite and allowed-domain routes accept a role slug wherever they accept a level today. The existing rules stay: a user cannot change their own role, and the last-admin guard counts enabled users with the built-in Admin role.

- **CLI.** `emdash role list|get|create|update|delete`, going through the REST API like `emdash menu` and `emdash taxonomy`.
- **Seed.** `SeedFile` gains `roles?: SeedRole[]` with the shape of the create body. Applying a seed creates missing roles and updates existing ones by slug. `emdash export-seed` writes the section.

### Localization and accessibility

The role editor, the role picker and every new error message in the admin go through Lingui, and the matrix uses logical Tailwind classes and is tested in Arabic. Permission names stay identifiers; the admin shows a translated label and description for each. Custom role labels are site data and are not translated. The matrix is a table with row and column headers, and each cell is a labelled checkbox.

## Compatibility and migration

- **Existing sites.** No step is required. Every user keeps a built-in role and `role_id` is `NULL`.
- **Migration.** One migration creates `_emdash_roles` and adds the three nullable columns and their indexes, with `ifNotExists` guards so it can restart after any statement. `down` drops the columns and the table.
- **Rolling deploy.** Code deployed before the migration ignores the new table and columns. Code deployed after it treats a `NULL` reference as a built-in role, and selects without the join while the table is missing.
- **Rollback.** An older version reads `users.role`, which holds the compatibility level, so a user with a custom role keeps at most the built-in role the custom role contains, or Subscriber.
- **Public API.** `/auth/me` gains fields and changes none. The authorization helpers gain an optional argument. Identity-provider options accept a slug in addition to a number. No export is removed.
- **Behavior change for built-in roles.** None by design. Phase 1 settles MCP tools whose level differs from the REST permission; each such change is listed in that phase's changeset.
- **Plugin authors.** Declare a `permission` on each route, as the plugin documentation already describes, and avoid comparing `ctx.user.role`.
- **Documentation.** The role table in the authentication guide stays valid for built-in roles. A new page covers custom roles, the seed section and the compatibility level.

## Security and privacy

- **Fail closed.** No actor, an unknown role reference, an unknown permission name, and a check without a collection against a scoped grant all deny.
- **Privilege escalation.** Only holders of `roles:manage` create, change and assign roles, and custom roles cannot hold it or the user-management permissions. Whether other Admin-level permissions open an indirect path to full control is an open question.
- **Older code.** With the compatibility level, a version that does not know custom roles grants at most the built-in role the custom role contains, or Subscriber.
- **No field-level permissions.** Field read restrictions have leaked through filtering, sorting and relation traversal in other CMSs: Strapi [GHSA-rjg2-95x7-8qmx](https://github.com/strapi/strapi/security/advisories/GHSA-rjg2-95x7-8qmx), Payload [GHSA-9g87-32v6-3c2r](https://github.com/payloadcms/payload/security/advisories/GHSA-9g87-32v6-3c2r) and [GHSA-fpww-c55p-cjv6](https://github.com/payloadcms/payload/security/advisories/GHSA-fpww-c55p-cjv6). A collection scope is decided once per request and collection. Reads that cross collections still have to apply it, which [Verification](#verification) covers.
- **Kept invariants.** Users without `content:read_drafts` keep receiving 404 for unpublished entries. The empty-owner rule, the last-admin guard, the ban on changing one's own role and scope clamping at token refresh stay.
- **Role changes take effect** on the user's next request, because the role row is read with the user row.
- **Privacy.** No new personal data is stored. `/auth/me` returns only the caller's own permissions.

## Performance

- **Logged-out routes.** No change. Anonymous requests load no user and no role. The query-count snapshots for logged-out routes must not change.
- **Authenticated requests.** The user lookup gains a join on a primary key, in the same query. No request issues an additional round trip, for built-in or custom roles.
- **Checks.** `can` is an in-memory set lookup. The grant sets are built once per request from the joined row.
- **`/auth/me`.** The response grows by about 50 short strings for an Admin.

## Failure handling

- **Stored role with invalid JSON.** The role yields no grants, so every check for that user denies, and the error is logged with the `[auth]` prefix. An Admin repairs the role through the API or the editor.
- **Role deleted while referenced.** The API refuses. If a row disappears outside the API, the user's reference yields no grants and every check denies until an Admin assigns a role.
- **Migration interrupted.** Each statement is guarded and the migration restarts where it stopped. Until it completes, the join is skipped and every user acts with the built-in role in `users.role`.
- **Seed with an unknown permission.** Seed validation fails before anything is written, naming the role and the permission.

## Verification

- **Equivalence.** For each built-in role and each permission, `can` returns what `role >= Permissions[permission]` returns.
- **Scope.** Route tests with a collection-scoped role cover the content routes, the routes without a collection in the URL, search, the calendar, the collection list, and relations that point into a collection the role may not read.
- **Parity.** One table of operations drives REST and MCP tests, so both surfaces are asserted against the same permission.
- **Query counts.** The logged-out snapshots do not change. A test asserts the round trips of an authenticated content request with a built-in role and with a custom role.
- **Migration.** Upgrade from existing data, retry after a partial run, and every supported dialect with `describeEachDialect`.
- **Compatibility level.** Derivation tests, and a test that code reading only `users.role` never grants more than the custom role, apart from the Subscriber floor.
- **Admin.** Playwright runs the example's `jobs-editor` through the sidebar, an entry in `jobs`, and a direct URL to an entry in `posts`. The role editor is checked in Arabic.

## Rollout and implementation

| Phase | Content                                                                                                                                                                                                                                                                      | Schema change |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1     | `can` and the equivalence test. Permission names replace the role comparisons in the user-management routes, MCP and visual editing, with `roles:manage` and any other Admin-level name that is missing. Effective permissions in `/auth/me`. `useCan` in the admin.         | None          |
| 2     | `_emdash_roles` and the references. Collection scope in content routes, cross-collection reads and MCP tools. The roles API, the seed section and the CLI. Role slugs in identity-provider mappings. Token scopes derived from grants. Custom roles in the user role picker. | Additive      |
| 3     | The role editor: a permission matrix that starts from a built-in role as a template. Documentation.                                                                                                                                                                          | None          |

Each phase is a separate set of pull requests and ships without a feature flag, because no behavior changes until a site creates a custom role. Phase 1 can be accepted on its own. I will implement phases 1 and 2.

### Reconciliation with editorial comments

[Editorial comments](https://github.com/emdash-cms/emdash/pull/4126) adds `editorial:comment` and `editorial:manage` and names this RFC. Both permissions are scopable, because every editorial route has the collection in its path. Its mentionable-users endpoint, which it places per entry for a future collection-scoped model, lists users who hold `editorial:comment` for the entry's collection. If both are accepted, the second to land carries this.

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
- **Roles are no longer ordered.** Code and documentation that say "at least Editor" have no meaning for a custom role. The compatibility level is a conservative answer apart from the Subscriber floor, and it hides plugin panels with a `minRole` from custom roles that hold the underlying permissions.
- **A collection slug is a reference by name.** A scope entry outlives a deleted collection and applies to a new collection with the same slug.
- **A larger test surface.** Each content route needs a scoped case.

## Open questions

- **The Subscriber floor.** Should every custom role be required to contain the Subscriber permissions? That would remove the exception in the compatibility level, and it would forbid roles like `jobs-editor` that must not read other collections.
- **Compatibility level after an upgrade.** A permission that a release adds at or below a custom role's level is not part of that role, so the role no longer contains the level it is stored at. Recompute the level on upgrade, which can lower it, or keep it?
- **Admin-level permissions in custom roles.** `plugins:manage`, `schema:manage`, `settings:manage`, `backups:manage` and the transfer permissions each need a decision on whether holding them amounts to full control of the site, and therefore whether a custom role may hold them.
- **Plugin routes with a collection.** A plugin editor panel acts on one entry, and a collection-scoped role that may publish that entry cannot call a plugin route that requires `content:publish_any`. Should the host pass the entry's collection from context it controls, so scoped grants can satisfy plugin routes?
- **Visual editing.** Should edit mode on site pages require `content:edit_own` for the collection of an entry on the page, instead of a level?
- **Own drafts only.** Every role with `content:read_drafts` sees all drafts, revisions and trashed entries of a collection. A role for external users, as in #2317, may need to see only its own entries. Leave this for a follow-up proposal?
- **One role per user.** Several additive roles per user is the alternative.
