---
title: User groups and resource-scoped roles
type: rfc
status: proposed
authors:
  - Matt Kane (@ascorbic)
champion: Matt Kane (@ascorbic)
sponsor: Matt Kane (@ascorbic)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4132
  - https://github.com/emdash-cms/emdash/discussions/3717
created: 2026-11-25
---

# User groups and resource-scoped roles

## Summary

Admins assign a role to a person or group for the whole site, a collection, or a selected entry. Someone can publish Jobs and prepare draft revisions in Pages. A second person gets the same access by joining the same group.

### Relationship to the custom roles proposal

[Custom roles and collection-scoped permissions](https://github.com/emdash-cms/emdash/pull/4156) proposes storing the collection names alongside permissions in the role definition. This draft proposes one change to that design. A role defines permissions, and its assignment identifies the collection. An admin can then use the same Publisher role on Jobs, Events, or an individual page. Collection access remains part of the custom roles proposal, including its REST and MCP checks, cross-collection queries, role editor, and compatibility guarantees. In the admin, the collection picker belongs where the role is assigned.

The two proposals would share one assignments table. Direct collection assignments can ship with custom roles. This proposal adds group membership, group assignments, and entry sharing. This division is open for review. Both proposals need to agree on the role representation before either one introduces stored grants.

This RFC covers editorial and administrative access to public content. Restricted readership for private or audience-limited content, and any content-side container for grouping entries (such as spaces, folders, or access presets), are left out of scope until their own requirements are settled.

## Problem and user case

[Custom roles and collection-scoped permissions](https://github.com/emdash-cms/emdash/pull/4156) lets a site define custom roles and restrict a role's content permissions to chosen collections, while keeping one role per user (`users.role_id`). That covers single-collection editors (such as a `jobs-editor`) without complicating simple sites.

Two recurring cases on larger sites fall outside one collection-scoped role per user:

1. **Subsets of entries inside one large collection.** Marketing and documentation sites often keep hundreds of entries in a single `Pages` collection that shares blocks, fields, and routing. Collection-level permissions are all-or-nothing across all of those entries. Splitting `Pages` into one collection per team breaks shared templates and references. Within one collection, a single person often needs different rights on different entries — for example, publishing Events pages while only drafting edits to Careers pages — or multiple teams collaborate on the same set of launch pages (Product drafts, Brand edits copy, Comms publishes).
2. **Many-to-many team membership and identity-provider groups.** People belong to multiple teams. `packages/cloudflare/src/auth/cloudflare-access.ts` already fetches `identity.groups` and GitHub `teams` at sign-in and uses the first matching group to choose a numeric role via `roleMapping`. That single level cannot express simultaneous memberships.

Putting per-entry grants into `#4156`'s single-role model would require a separate custom role for every combination of teams a person belongs to. Adding a second, unrelated ACL action vocabulary alongside `#4156`'s permissions would force admins to reconcile two overlapping systems. Reusing `#4156`'s roles in scoped assignments keeps one permission model.

## Example

### Onboard two editors with the same responsibilities

An admin gives the Editorial group four assignments. Media uploader, Publisher and Draft editor are reusable custom roles.

| Role           | Scope                      | What a member can do                                                                |
| -------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| Media uploader | Site                       | Read and upload media                                                               |
| Publisher      | Jobs collection            | Create, edit and publish jobs                                                       |
| Draft editor   | Pages collection           | Read entries and prepare draft revisions, including on a colleague’s published page |
| Publisher      | Six selected Pages entries | Edit and publish those six pages                                                    |

The admin invites Sam with a Subscriber base role and selects Editorial. Accepting the invitation adds Sam to the group. Invites and allowed-domain defaults gain an optional group selection alongside the base role. A site can select the same group for signups from an allowed domain or map an identity-provider group to Editorial. The account receives the current assignments through membership. A second invite for Lee refers to the same group.

On first sign-in Sam can upload a photo and publish a job. On an ordinary published Careers page, saving a proposed revision leaves the live revision and public page intact. Both the publish endpoint and MCP refuse Sam’s request to publish it. On a launch page, **Inspect access** shows that Editorial grants Publisher directly on the entry. An older plugin reading Sam’s numeric role sees Subscriber. A scoped publishing permission must never raise that number. An existing site-wide Editor retains their base role.

When the launch ends, the admin selects the six entries in **Manage access** and removes Editorial’s Publisher assignments. Sam and Lee retain the collection-wide draft permission. A seventh page receives collection and site permissions when created. Creating pages requires a grant at site or collection scope.

### Cross-team product launch

Six launch pages in `pages` need collaboration from three teams without forcing one team to own them. An Admin selects the six pages in the `Pages` list, chooses **Manage access**, and assigns:

- `product` -> `draft-editor`
- `brand` -> `copy-editor` (custom role with `content:edit_any`, no publish)
- `comms` -> `publisher`

Each page displays all three assignments and lets an Admin inspect why any user can or cannot perform an action on it.

The Product role can save proposed revisions. Brand can edit entries, and Comms can publish. If Brand also needs draft-only editing, the admin can assign Draft editor to Brand.

## Goals

- Admins can create local user groups and sync memberships from identity providers (starting with Cloudflare Access groups and GitHub teams) without overwriting manual memberships.
- Admins can assign built-in or custom roles from `#4156` to users or groups at site, collection and entry scope, including bulk assignment across selected entries.
- REST routes, MCP tools, co-editing rooms, editorial comments, and the admin UI evaluate the same effective permissions from the union of a user's base role and matching scoped assignments.
- Scoped assignments activate only the permissions eligible for their scope type and never grant reserved administrative permissions.
- The admin UI surfaces assignments on the resources themselves, on groups, and on user profiles; warns inline when an assignment is shadowed by a broader grant or when a removal leaves access in place; and provides an access-inspection view with grant provenance.
- Anonymous logged-out requests issue zero additional queries. Authenticated requests for users without scoped assignments issue zero additional round trips.
- All schema changes are additive and support rolling deploys and `manual` migration mode.

## Non-goals

- **Restricted readership and private published content.** Restricting who can read published entries on the public site, search indexes, feeds, sitemaps, route caches, and R2/S3 media URLs requires cache invalidation, inherited-visibility propagation, and media delivery controls. That belongs in a separate RFC.
- **Content-side containers (`Areas`, `Folders`, `Spaces`, or owning `Teams`).** This RFC assigns roles to existing EmDash resources rather than introducing a new container noun. Whether new entries need a reusable access preset or container depends on real creation workflows (see [Open questions](#open-questions)).
- **Tag- or rule-driven entry access.** Taxonomies classify content for readers and editors; adding or removing a term on an entry never changes who can edit or publish it.
- **Deny rules or role ceilings.** Assignments only add access; they do not subtract permissions granted by the user's base role or another assignment.
- **Locale-scoped assignments.** Entry assignments apply across locales via `translation_group`, matching `#4156`.
- **Field-level permissions or media-file ACLs.**
- **Approval workflows.** A role without `content:publish_own` or `content:publish_any` cannot publish, which existing permissions express.

## Detailed design

### Prerequisites from `#4156`

This RFC builds on `#4156`'s `_emdash_roles` table, `Actor` type, `hasPermission(actor, permission, resource)`, entry-level authorization helpers (`entryEditAccess`, `entryReadAccess`), and the shared read-policy helper introduced for Phase 4 (`content:read_own_drafts`). It relies on `resource` remaining an extensible object (`{ collection?: string }`) and on single-entry checks taking entry context rather than a bare `ownerId`.

### Terms

| Term            | Meaning                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Group           | A named set of users (`_emdash_groups`). Holds no permissions of its own.                                       |
| Subject         | Either a user (`user:{userId}`) or a group (`group:{groupId}`).                                                 |
| Scope           | A target resource identified by `scope_type` and `scope_id`.                                                    |
| Role assignment | A binding `(subject, role, scope)` granting the role's scope-eligible permissions to the subject on that scope. |
| Base role       | The user's single site role from `users.role` / `users.role_id` (`#4156`).                                      |

### Scopes and eligible permissions

A scoped assignment activates **only** the permissions defined for its `scope_type`. Site-wide permissions on a built-in or custom role (such as `settings:read`, `schema:read`, `widgets:manage`, or `menus:manage`) are never activated by a collection or entry assignment.

| `scope_type` | `scope_id` format                       | Eligible permissions                                                |
| ------------ | --------------------------------------- | ------------------------------------------------------------------- |
| `site`       | Constant `site`                         | Assignable permissions across the site, including media permissions |
| `collection` | `{collection_slug}`                     | `content:*`, `editorial:*`                                          |
| `entry`      | `{collection_slug}:{translation_group}` | Entry-level `content:*` (except `content:create`), `editorial:*`    |

Rules for scope eligibility:

- **Reserved permissions and built-in Admin.** Built-in `Role.ADMIN` (50) cannot be used in `_emdash_role_assignments`. Reserved permissions listed in `#4156` (`users:*`, `settings:manage`, `plugins:manage`, `schema:manage`, `import:execute`, `transfer:*`, `backups:manage`, `auth:manage_connections`, and API token / OAuth client management) are never eligible on any scope.
- **No-op assignments rejected at write time.** Creating an assignment whose role contributes zero eligible permissions on the target scope fails with `400 VALIDATION_ERROR`. For example, assigning a role that holds only media permissions to a page is rejected before writing.
- **Duplicating or translating an entry.** `content:create` is collection-scoped rather than entry-scoped: creating a new entry requires `content:create` in the collection (from the base role or a `collection` assignment). Creating a translation of an existing entry where the user holds an `entry` assignment with edit access checks whether the user holds `content:create` in the collection, matching `#4156`.

### Authorization evaluation

The `resource` argument on `hasPermission`, `canActOnOwn`, `requirePerm`, `requireOwnerPerm`, `entryEditAccess`, and `entryReadAccess` extends additively:

```ts
interface AuthResource {
	collection?: string;
	translationGroup?: string;
}
```

Evaluation for `hasPermission(actor, permission, resource)`:

1. A missing actor is a denial.
2. Check the actor's **base role** using `#4156`'s rules against `resource`. If allowed, return `true`.
3. If `actor.assignments` is empty, return `false`.
4. Determine the enclosing scopes for `resource`:
   - Every request includes the site scope, including checks without a resource. Also include the following scopes when the server has resolved the resource.
   - `{ collection, translationGroup }` -> `collection:{collection}`, `entry:{collection}:{translationGroup}`
   - `{ collection }` -> `collection:{collection}`
5. For every assignment in `actor.assignments` matching one of those scopes:
   - Resolve the assigned role's grants (applying `#4156`'s inclusion rules: `_any` includes `_own`, `content:edit_own` includes `content:edit_own_drafts`, `content:read_drafts` includes `content:read_own_drafts`, `manage` includes `read`).
   - Intersect with the scope type's eligible permissions.
   - If the resulting set contains `permission`, return `true`.
6. Otherwise return `false`.

Ownership checks (`canActOnOwn`) stay unchanged: if `entry.authorId !== ""` and `entry.authorId === actor.id`, check `ownPermission` via `hasPermission(actor, ownPermission, resource)`; otherwise check `anyPermission` via `hasPermission(actor, anyPermission, resource)`. Assigning `Author` to a user on an entry therefore grants `edit_own`/`publish_own` only when they are the entry's author, while assigning `Editor` or a custom `publisher` role (`edit_any`/`publish_any`) applies regardless of `authorId`.

### Content routes, lists, and MCP

- **Reachability.** The pre-load collection check from `#4156` (returning 403 before loading an entry in an unreachable collection) accounts for site grants and passes when the actor holds any content permission on `collection:{collection}` or on at least one `entry` in that collection. For a single-entry route where the user holds only entry-scoped assignments in that collection, an entry the user has no assignment for answers 404 (matching `#4156`'s non-disclosure rule for unreachable entries).
- **List queries and cross-collection reads.** Content lists, counts, trash, calendar, dashboard, and MCP list tools use `#4156`'s shared read-policy helper. When an actor lacks collection-wide `content:read` (or `content:read_drafts`) but holds `entry` assignments in that collection, the read-policy helper adds a predicate matching `translation_group IN (...)` (or `EXISTS` against `_emdash_role_assignments` when the set exceeds a small inline threshold, chunked at `SQL_BATCH_SIZE`). Filters, sorts, and counts operate only on rows the predicate keeps.
- **Reference fields and revisions.** Reference resolution, reference writes, revision reads, compare, preview URLs, and bulk tagging pass `{ collection, translationGroup }` to the shared read/edit helpers.
- **MCP.** MCP tools pass the same `AuthResource` object to the shared helpers.

### Data model

The combined design uses the following tables. Direct collection assignments use the shared role-assignment table from the proposed amendment to #4156.

#### `_emdash_groups`

| Column         | Type               | Notes                                                    |
| -------------- | ------------------ | -------------------------------------------------------- |
| `id`           | `text` primary key | ULID                                                     |
| `slug`         | `text` unique      | `/^[a-z][a-z0-9_-]*$/`, max 63 chars                     |
| `label`        | `text`             | Display name                                             |
| `description`  | `text` nullable    |                                                          |
| `source`       | `text`             | `'local'` or `'idp'`, default `'local'`                  |
| `idp_provider` | `text` nullable    | e.g. `'cloudflare-access'`; null for purely local groups |
| `external_id`  | `text` nullable    | External group name or ID when mapped to an IdP group    |
| `created_at`   | `text`             | `currentTimestamp(db)` default                           |
| `updated_at`   | `text`             | `currentTimestamp(db)` default                           |

Partial unique index `idx__emdash_groups_idp_external` on `(idp_provider, external_id) WHERE idp_provider IS NOT NULL AND external_id IS NOT NULL`.

#### `_emdash_group_members`

| Column       | Type   | Notes                                           |
| ------------ | ------ | ----------------------------------------------- |
| `group_id`   | `text` | FK to `_emdash_groups.id` (`ON DELETE CASCADE`) |
| `user_id`    | `text` | FK to `users.id` (`ON DELETE CASCADE`)          |
| `source`     | `text` | `'local'` or `'idp'`, default `'local'`         |
| `created_at` | `text` | `currentTimestamp(db)` default                  |

Primary key `(group_id, user_id, source)`. Index `idx__emdash_group_members_user_id` on `(user_id)`. A user can hold both a `local` row and an `idp` row in the same group; group member API responses and the admin UI deduplicate by `user_id` and show all active source badges.

#### `_emdash_invite_groups` and `_emdash_allowed_domain_groups`

Two small join tables attach optional initial groups to invites (`auth_tokens.hash`) and allowed signup domains (`allowed_domains.domain`) without altering either existing table:

- `_emdash_invite_groups`: `token_hash` (`text`, FK to `auth_tokens.hash`, `ON DELETE CASCADE`) and `group_id` (`text`, FK to `_emdash_groups.id`, `ON DELETE RESTRICT`), primary key `(token_hash, group_id)`, index on `(group_id)`.
- `_emdash_allowed_domain_groups`: `domain` (`text`, FK to `allowed_domains.domain`, `ON DELETE CASCADE`) and `group_id` (`text`, FK to `_emdash_groups.id`, `ON DELETE RESTRICT`), primary key `(domain, group_id)`, index on `(group_id)`.

#### `_emdash_role_assignments`

| Column          | Type               | Notes                                                                                       |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `id`            | `text` primary key | ULID                                                                                        |
| `subject_type`  | `text`             | `'user'` or `'group'`                                                                       |
| `subject_id`    | `text`             | User ID or group ID                                                                         |
| `role_id`       | `text` nullable    | FK to `_emdash_roles.id` (`ON DELETE RESTRICT`)                                             |
| `built_in_role` | `integer` nullable | `10`, `20`, `30`, or `40` (never `50`)                                                      |
| `scope_type`    | `text`             | `'site'`, `'collection'` or `'entry'`                                                       |
| `scope_id`      | `text`             | Resource identifier per [Scopes and eligible permissions](#scopes-and-eligible-permissions) |
| `created_by`    | `text` nullable    | User ID of the admin who created the assignment                                             |
| `created_at`    | `text`             | `currentTimestamp(db)` default                                                              |

Constraints and indexes:

- Check constraint enforcing `(role_id IS NOT NULL AND built_in_role IS NULL) OR (role_id IS NULL AND built_in_role IN (10, 20, 30, 40))`.
- Partial unique indexes preventing duplicate assignments on the same subject, scope, and role:
  - `idx__emdash_role_assignments_unique_custom` on `(subject_type, subject_id, scope_type, scope_id, role_id) WHERE role_id IS NOT NULL`
  - `idx__emdash_role_assignments_unique_builtin` on `(subject_type, subject_id, scope_type, scope_id, built_in_role) WHERE built_in_role IS NOT NULL`
- Lookup indexes:
  - `idx__emdash_role_assignments_subject` on `(subject_type, subject_id)`
  - `idx__emdash_role_assignments_scope` on `(scope_type, scope_id)`
  - `idx__emdash_role_assignments_role_id` on `(role_id)`

Cleanup rules:

- Deleting a group removes expired invite references from `_emdash_invite_groups`, refuses with `409 GROUP_IN_USE` while any unexpired invite or allowed domain references the group, and otherwise deletes its `subject_type = 'group'` rows from `_emdash_role_assignments` in the same handler flow. Deleting a user deletes their `subject_type = 'user'` rows from `_emdash_role_assignments`.
- Deleting a custom role in `#4156` checks `_emdash_role_assignments` in addition to `users`, `auth_tokens`, and `allowed_domains`, and returns `409 ROLE_IN_USE` with the assignment count while referenced.
- Permanently deleting the last locale row of a `translation_group` or deleting a collection removes matching `_emdash_role_assignments` rows.

### Loading groups and assignments

To keep authenticated requests fast on sites that do not use scoped assignments, the existing user lookup (`getUserById`, `getUserByEmail`) includes a scalar existence probe in its `SELECT` list:

```sql
EXISTS (
  SELECT 1 FROM _emdash_role_assignments a
  WHERE (a.subject_type = 'user' AND a.subject_id = users.id)
     OR (a.subject_type = 'group' AND a.subject_id IN (
          SELECT gm.group_id FROM _emdash_group_members gm WHERE gm.user_id = users.id
        ))
) AS has_scoped_assignments
```

- **Anonymous requests:** Skip the user lookup.
- **Authenticated user with `has_scoped_assignments = 0`:** Zero follow-up queries run; `actor.assignments` is empty.
- **Authenticated user with `has_scoped_assignments = 1`:** One indexed query wrapped in `requestCached` loads the user's group memberships and matching assignments (with a `LEFT JOIN _emdash_roles ON a.role_id = _emdash_roles.id`) for the duration of the request.

During a rolling deploy on a `manual` migration site before the tables exist, the adapter catches missing-table errors using the same fallback window as `#4156` and evaluates base roles only until the migration completes.

### Identity provider group sync

Cloudflare Access (`packages/cloudflare/src/auth/cloudflare-access.ts`) gains optional configuration alongside `roleMapping` and `syncRoles`:

```ts
cloudflareAccess({
	// Existing single-role mapping stays unchanged
	roleMapping: { "site-admins": 50 },
	defaultRole: 10,
	// New optional group mapping: IdP group or GitHub team name -> EmDash group slug
	groupMapping: {
		"editorial-team": "editorial",
		"brand-reviewers": "brand",
	},
	syncGroups: true,
});
```

At sign-in:

- EmDash matches `identity.groups` and GitHub teams against `groupMapping`. Unmapped IdP groups are ignored.
- Mapped target slugs that do not yet exist in `_emdash_groups` are logged under `[auth]` and skipped (admins create the target group before enabling the mapping).
- For mapped groups, EmDash reconciles only `source = 'idp'` rows in `_emdash_group_members` for that user: adds newly present groups and removes IdP memberships the user no longer holds. Rows with `source = 'local'` are never modified by IdP sync.
- Other OIDC/OAuth providers can populate the same `syncUserIdpGroups(db, userId, provider, externalGroupIds)` helper when they expose group claims.

### Effective permissions in `/auth/me` and the admin UI

`/auth/me` adds two additive fields:

```json
{
	"groups": [{ "id": "01JZ...", "slug": "editorial", "label": "Editorial" }],
	"scopedPermissions": {
		"collections": {
			"jobs": [
				"content:read",
				"content:read_drafts",
				"content:read_own_drafts",
				"content:create",
				"content:edit_own",
				"content:edit_own_drafts",
				"content:edit_any",
				"content:publish_own",
				"content:publish_any"
			]
		},
		"entryCollections": ["pages"]
	}
}
```

- Site assignments contribute to the existing effective site-permission list. An assignment on a collection or entry can never add permissions to that list.
- `entryCollections` lists collections where the user holds at least one entry-scoped assignment so the admin sidebar shows `Pages` even when the user has no collection-wide grant on `pages`.
- To avoid bloating `/auth/me` when a user has hundreds of entry assignments, content list and entry detail responses include the caller's effective entry capabilities (`_access: { canEdit, canEditDraft, canPublish, canDelete, canComment }`) when the user relies on entry-scoped assignments in that collection (omitted when collection-wide grants already decide every row).
- `useCan(permission, resource)` accepts `{ collection?, translationGroup? }` and reads from `/auth/me` (or the loaded entry's `_access`).

#### Admin UI

The admin avoids exposing a raw `(subject, role, scope)` bindings table. Instead, it presents assignments through three views, with progressive disclosure so sites without groups or assignments see no extra chrome on collections or entries:

1. **In context on content (primary workflow).**
   - **Content list bulk action:** Selecting entries enables **Manage access**, letting an Admin add or remove `(user | group, role)` assignments across the selected entries in one step.
   - **Entry editor:** An **Access** section in the sidebar lists direct assignments on the entry (plus a collapsed summary of collection-wide roles that apply).
   - **Collection access:** A collection's settings or header provides an **Access** dialog for assigning groups or users to the whole collection.
   - **Role picker guardrails:** The picker filters to roles that activate at least one permission on the current scope (excluding `Admin`) and displays concise capability chips (`Create · Edit · Publish`) under each role name.
   - **Inline overlap warnings at the point of change:** Before confirming an assignment, the dialog checks the target subject's existing effective access and warns inline when the assignment adds nothing (for example, _"Sam already has publish access here through their site-wide Editor role"_). Before confirming a removal, it warns when members retain access through another group, a direct assignment, or their base role.
2. **Groups page (`Admin -> Groups`, beside Users and Roles).**
   - Lists local and IdP-synced groups with source badges and member counts.
   - Group detail shows members (editable for local memberships, read-only with provider label for IdP memberships) and a **"Where this group has access"** list of all assignments for that group, with quick add/remove.
3. **User detail and "Inspect access" (`Admin -> Users -> {user}`).**
   - Displays the user's base role, group memberships, and rolled-up scoped assignments.
   - **Inspect access** (reachable from both a user profile and an entry's Access panel) evaluates a `(user, resource)` pair and explains each permission with its exact source — base role, direct assignment, or group assignment — or states that no grant covers it.

All admin strings use Lingui (`useLingui` / `<Trans>` / `msg`), all layouts use RTL-safe logical Tailwind classes, and Kumo components (`Dialog`, `Select`, `Badge`, `Button`, `ConfirmDialog`) are used throughout.

### API, CLI, and seed

REST endpoints (all require `X-EmDash-Request: 1` for mutations and Zod body validation via `parseBody`):

| Method and path                                            | Permission     | Purpose                                                                         |
| ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `GET /_emdash/api/admin/groups`                            | `users:read`   | Paginated `{ items, nextCursor? }` list of groups with member counts            |
| `POST /_emdash/api/admin/groups`                           | `users:manage` | Create a group (`{ slug, label, description? }`)                                |
| `GET /_emdash/api/admin/groups/{slug}`                     | `users:read`   | Group details, members, and assignments                                         |
| `PATCH /_emdash/api/admin/groups/{slug}`                   | `users:manage` | Update label or description                                                     |
| `DELETE /_emdash/api/admin/groups/{slug}`                  | `users:manage` | Delete a group and its memberships and assignments                              |
| `POST /_emdash/api/admin/groups/{slug}/members`            | `users:manage` | Add local members (`{ userIds: string[] }`)                                     |
| `DELETE /_emdash/api/admin/groups/{slug}/members/{userId}` | `users:manage` | Remove only the `source = 'local'` membership (409 if managed solely by IdP)    |
| `GET /_emdash/api/admin/role-assignments`                  | `users:read`   | Paginated list filterable by `subjectType`, `subjectId`, `scopeType`, `scopeId` |
| `POST /_emdash/api/admin/role-assignments`                 | `users:manage` | Create one assignment; returns inline overlap warnings                          |
| `POST /_emdash/api/admin/role-assignments/bulk`            | `users:manage` | Add or remove assignments across up to 100 entries per request                  |
| `DELETE /_emdash/api/admin/role-assignments/{id}`          | `users:manage` | Delete an assignment; returns remaining-access summary                          |
| `GET /_emdash/api/admin/access-explain`                    | `users:read`   | Explain effective permissions and grant sources for `(userId, scope)`           |

The CLI adds `emdash group list|get|create|update|delete|add-member|remove-member` and `emdash access list|grant|revoke|explain`, going through the REST API like `emdash role`, `emdash menu`, and `emdash taxonomy`. `emdash export-seed` writes the `groups` and `roleAssignments` seed sections.

`.emdash/seed.json` adds optional `groups` and `roleAssignments` sections:

```json title=".emdash/seed.json"
{
	"version": "1",
	"groups": [
		{ "slug": "editorial", "label": "Editorial" },
		{ "slug": "brand", "label": "Brand" }
	],
	"roleAssignments": [
		{
			"group": "editorial",
			"role": "media-uploader",
			"scope": { "type": "site" }
		},
		{
			"group": "editorial",
			"role": "publisher",
			"scope": { "type": "collection", "collection": "jobs" }
		}
	]
}
```

### Tokens, plugins, co-editing, editorial comments, and visual editing

- **API tokens and OAuth.** Effective access stays `token_scopes ∩ effective_permissions`. Token scope clamping derives allowed scopes from the user's base role plus any scoped assignments (never offering `admin` or `mcp:tools` unless the base role holds them).
- **Plugins.** `users.role` continues to store the base role's compatibility level from `#4156`. On entry-editor plugin extension routes (`content/{collection}/{id}/plugin-extensions/...`), the host passes `{ collection, translationGroup }` after verifying the entry so entry-scoped assignments satisfy the route. General plugin routes can evaluate site grants only. Plugins reading the legacy numeric role continue to see the base role’s compatibility level.
- **Real-time co-editing (`proposals/real-time-co-editing.md`).** Room join and room saves authorize through `entryReadAccess` and `entryEditAccess` with `{ collection, translationGroup }`, so an entry-scoped collaborator joins and saves in that room. Revoking an assignment applies on the room's next save (and within the existing 15-minute read-connection bound).
- **Editorial comments (`proposals/editorial-comments.md`).** `editorial:comment` and `editorial:manage` are eligible on `collection` and `entry` scopes. The entry mentionable-users endpoint includes users who hold `editorial:comment` and draft-read access via either their base role or a matching assignment on that collection or entry.
- **Visual editing.** Unchanged from `#4156`: edit mode requires unscoped `content:edit_own` and `content:read_drafts`.

## Compatibility and migration

- **Additive schema only.** The custom roles proposal introduces the shared assignments table. Additive migrations introduce groups, membership and group selections for invites and allowed domains. Existing invites and domains default to an empty selection. Consuming an invite records its local memberships idempotently with account provisioning. An invalid group selection must be resolved before provisioning succeeds.
- **Backwards compatibility.** Existing sites, built-in roles, `#4156` custom roles, plugins, tokens, and Cloudflare Access `roleMapping` configs keep identical behavior with zero configuration changes.
- **Rolling deploys and rollback.** During a rolling deploy before the migration runs in `manual` mode, missing-table errors fall back to base-role-only checks and retry after one minute. Rolling back to a build without this feature leaves the new tables unused and reverts to `#4156` base roles safely.
- **Versioning.** Minor version bump in `@emdash-cms/auth`, `emdash`, `@emdash-cms/admin`, and `@emdash-cms/cloudflare`, with user-facing changesets for each changed package.

## Security and privacy

- **Scope isolation.** Every scoped assignment is filtered through the static eligibility map for its `scope_type`. Assigning built-in `Editor` on a collection or entry never grants settings, menus, taxonomies, schema, or plugin access. Built-in `Admin` and all `#4156` reserved permissions are rejected on every scoped assignment.
- **Non-disclosure (404 vs 403).** On a collection reachable only through entry-scoped assignments, single-entry routes return 404 for entries the actor is not assigned to, preventing entry-ID or slug enumeration.
- **No privilege escalation via role edits or group sync.** Only `users:manage` can create groups, edit memberships, or create/delete assignments. IdP group sync only updates explicitly mapped groups and removes `source = 'idp'` memberships when an IdP group is no longer present in the user's Access identity (effective on the user's next Access identity refresh / sign-in).
- **Bounded bulk writes.** `POST /_emdash/api/admin/role-assignments/bulk` caps request size (100 entries), validates that every target entry exists in the named collection, and chunks SQL statements at `SQL_BATCH_SIZE`.
- **Privacy.** Group lists, memberships, and `access-explain` require `users:read`. `/auth/me` exposes only the signed-in caller's own group memberships and effective scoped permissions.

## Performance

- **Logged-out hot path:** Zero additional queries; `pnpm query-counts` snapshots for SQLite and D1 must remain identical.
- **Authenticated users without assignments:** Zero additional round trips; the scalar `EXISTS` probe rides inside the existing `getUserById` / `getUserByEmail` query.
- **Authenticated users with assignments:** One indexed query per request, cached via `requestCached`.
- **D1 parameter limits:** Entry-list predicates and bulk assignment mutations chunk IDs at `SQL_BATCH_SIZE` (`packages/core/src/utils/chunks.ts`) and switch to a correlated `EXISTS` subquery against `_emdash_role_assignments` when a user's assigned entry count exceeds a small threshold.
- **Measurement plan:** Record authenticated query counts on both SQLite and D1 (anonymous, base-role user with no assignments, user with 5 group assignments, and user with 200 entry assignments across a 500-entry `pages` collection) before landing Phase 2.

## Failure handling

- **Unknown `scope_type` or invalid role reference:** Treated as zero grants (fail closed) and logged with the `[auth]` prefix.
- **Dangling `scope_id`:** If a collection or entry is deleted outside normal handlers, an orphaned assignment row never matches any active resource and causes no errors. Delete handlers clean up matching rows; a repair/prune CLI option can remove stale rows.
- **Partial failure on D1:** A bulk operation can span multiple batches. Bulk assignment creation uses idempotent inserts (`ON CONFLICT DO NOTHING`) and bulk deletion is idempotent, so retrying a partial request converges to the requested state.
- **IdP sync failure:** If Cloudflare Access `get-identity` fails at sign-in, existing behavior applies; `syncUserIdpGroups` does not wipe existing `source = 'idp'` memberships when the IdP omits the `groups` field due to a transient error.

## Verification

- **Unit tests (`packages/auth`):** Scope-eligibility filtering, reserved-permission rejection, built-in `Editor` scoped to a collection or entry not leaking site-wide grants, site grants with and without a resource, collection isolation, additive union across base role + direct assignment + multiple groups, and `canActOnOwn` interaction.
- **Database and migration tests (`describeEachDialect` on SQLite and Postgres):** Migration up/down, retry after partial run, missing-table fallback during pre-migration window, unique constraints, cascade cleanup on user/group/entry/collection deletion, and `409 ROLE_IN_USE` when deleting a custom role referenced by an assignment, and `409 GROUP_IN_USE` when deleting a group referenced by an unexpired invite or allowed domain.
- **Route, MCP, and reconciliation tests:** Worked examples (Sam and Lee joining Editorial, staging a Careers revision, and losing launch publishing access), REST and MCP parity table, 404 non-disclosure on unassigned entries, co-editing room join/save and revocation, and editorial comments mentionable-users inclusion.
- **IdP sync tests:** Cloudflare Access `groupMapping` adding and removing `source = 'idp'` memberships while preserving `source = 'local'` memberships, ignoring unmapped groups, and surviving missing `groups` payload.
- **Query-count tests:** Assert unchanged logged-out snapshots and zero extra round trips for authenticated users without assignments; benchmark a 500-entry collection list with 200 entry assignments on SQLite and D1.
- **Admin E2E (Playwright, including Arabic RTL):** Bulk **Manage access** on `Pages`, inline overlap warning when assigning a shadowed role, Groups page, User access summary, and **Inspect access** provenance view.

## Rollout and implementation

Three sequential phases, following the direct collection-assignment work:

| Phase | Scope                                                                                                                                                                                                                                                     | Schema change |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1     | `_emdash_groups`, `_emdash_group_members`, `_emdash_invite_groups`, and `_emdash_allowed_domain_groups`, Groups REST API, invite/domain group selections, CLI, seed support, admin Groups page, and Cloudflare Access group sync                          | Additive      |
| 2     | Extend the shared assignments table to site grants, groups and entries, evaluator and shared read/edit policy integration, REST/MCP/co-editing/editorial-comments enforcement, `/auth/me` and `useCan` updates, bulk assignment API, and `access-explain` | Additive      |
| 3     | Admin **Manage access** UI (entry sidebar, bulk list action, collection access), inline overlap warnings, user access summary, **Inspect access** drawer, and docs                                                                                        | None          |

### Reconciliation with related work

- **Custom roles (`#4156`, `proposals/custom-roles.md`):** The proposed amendment to #4156 introduces reusable roles, direct collection assignments, and deletion checks on referenced roles. This RFC extends those assignments to groups and entries and shares its read-policy helper.
- **Co-owners (`#4132`):** Direct per-entry role assignments cover the co-owner use case using the same mechanism without special-casing ownership checks.
- **Editorial comments (`proposals/editorial-comments.md`):** `editorial:comment` and `editorial:manage` participate in `collection` and `entry` scopes; mentionable users include assigned collaborators.
- **Real-time co-editing (`proposals/real-time-co-editing.md`):** Room admission and saves pass `{ collection, translationGroup }` through `entryReadAccess` and `entryEditAccess`.

## Alternatives

### Separate ACL action enum intersected with a role ceiling

An alternative model keeps `#4156` roles as a capability ceiling and adds a separate ACL table with its own levels (`view`, `edit`, `publish`). That introduces a second permission vocabulary alongside `rbac.ts`, makes debugging harder because admins have to consult two layers to know whether a grant took effect, and creates edge cases around `delete_own` leakage and unassigned entries. Reusing `#4156` roles in additive scoped assignments avoids those conflicts.

### Multiple base roles per user

Replacing `users.role_id` with a user-to-roles join table solves combining two collection-scoped roles, but still cannot target subsets of entries inside one collection without duplicating roles for every subset. One base role plus scoped assignments handles both while keeping the simple single-role path intact.

### Introducing a content container up front (`Areas`, `Folders`, `Spaces`, or owning `Teams`)

A container column (`area_id`, `folder_id`, `space_id`, or `team_id`) on `ec_*` tables would let hundreds of pages inherit permissions from one parent object, but each candidate carries its own mismatch:

- **Areas** invents an access-only abstraction that duplicates team names without matching how editors think about content.
- **Folders** implies a frontend URL hierarchy (`/events/summit`), creating mismatched expectations or breaking live URLs when permissions change.
- **Single owning Team** breaks on cross-team content such as a product launch where Product drafts, Brand edits, and Comms publishes.
- **Spaces** reshapes top-level navigation and fits a wiki workspace more than a general CMS.

Deferring the container leaves the data model open to adding another `scope_type` later once real creation workflows show what container (if any) editors expect.

### Dynamic rules or taxonomy-driven access

Scoping access by URL prefix or taxonomy term avoids manual assignment, but couples security boundaries to user-editable editorial fields. Changing a slug or removing a tag would silently grant or revoke access, and localized slugs complicate rule matching.

## Drawbacks

- **Additive-only semantics.** A scoped assignment cannot restrict a user whose base role already grants broader access. Sites using scoped access for a team must give those users a minimal base role (such as `Subscriber` or a custom `team-member` role), and the admin UI must warn inline when an assignment is shadowed.
- **No automatic inheritance for newly created entries yet.** Bulk **Manage access** handles existing pages and launch batches, but creating a new page inside a large shared collection requires assigning access after creation unless a follow-up adds an opt-in container or access preset.
- **Uniform role per group assignment.** Assigning a role to a group grants that role to every member of the group. Teams with mixed drafters and publishers need either separate groups (for example `editorial-drafters` and `editorial-publishers`) or individual assignments for publishers.
- **Custom roles do not automatically receive new core permissions.** Inherited from `#4156`: custom roles used in scoped assignments keep only the permissions they were granted until updated.

## Open questions

1. **Draft revision API.** Draft editor needs a distinct permission to create or update a draft revision of a colleague’s entry. The server must authorize the draft write and reject attempts to change the live revision, slug, publication state or schedule through it. Publishing uses the existing publish check. Decide the endpoint and permission spelling with the custom roles author. Verify that saving a revision leaves the public response unchanged, including during concurrent publication.

2. **Initial access when creating a new entry in a large shared collection.** For sites with hundreds of entries in one collection (such as `Pages`), how do editors currently decide who should edit and publish a newly created page? Should this RFC stop at bulk/manual assignment (plus optional "copy access" on duplicate), or include an opt-in reusable **Access policy** preset selectable on create?
3. **Who can manage assignments on an entry.** Should Phase 2 restrict all assignment writes to `users:manage`, or allow entry owners / collection Editors to share entries they control (bounded so a user cannot grant permissions they do not hold)?
4. **Serving per-entry capabilities at scale.** When a user holds hundreds of individual entry assignments, returning per-row `_access` from content list and detail endpoints keeps `/auth/me` small, at the cost of computing `_access` on list responses for scoped users. Is that tradeoff preferable to including a bounded entry-grants map in `/auth/me`?
