---
title: Read-only mode
type: rfc
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
champion: Noah Pham (@khoinguyenpham04)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/2022
created: 2026-10-28
---

# Read-only mode

## Summary

Read-only mode lets an administrator stop every write to a site except a short allowlist, for as long as needed. The public site and the admin stay readable. While the mode is on, people can sign in, read, export and back up. Every other write fails with `503 SITE_READ_ONLY`, whether it comes from the admin, the REST API, MCP, a plugin, the scheduler or code that writes a guarded table directly.

The state is one row in the `options` table. Database triggers on every guarded table refuse writes while the row exists, so the mode also applies to work that was already under way when it turned on. The existing site write fence reads the same row, so most writes are refused before they start, with a clean error. Writes the HTTP fence already checks gain no database round trip, and logged-out page renders don't change.

## Problem and user case

Administrators need to stop changes to a site while keeping it online:

- moving a site to another account or host, where edits made after the backup are lost;
- restoring from a backup or recovering from a bad import;
- responding to an incident, such as a compromised account, a misbehaving plugin or a wave of spam, while it is investigated;
- a legal hold, an audit or a content embargo;
- a database close to its size limit;
- keeping a retired site online as an archive.

EmDash gives an administrator no way to do this. A freeze depends on every editor seeing a message, and API tokens, plugins and the scheduler keep writing regardless.

The request has come up before. Ideas Discussion [#2022](https://github.com/emdash-cms/emdash/discussions/2022) asks for an admin setting that locks the dashboard to read-only. Issue [#2206](https://github.com/emdash-cms/emdash/issues/2206) asks for a toggle, available only to admins, that "would prevent any updates to any part of your EmDash site … especially when you have a lot of folks in your dashboard who might not all be easily reachable via chat".

Today's workarounds each leave writes open:

- Asking editors to stop depends on everyone reading the message.
- Demoting roles or disabling users is itself a set of writes that someone has to undo. API tokens, plugins and scheduled publishing keep writing.
- An edge rule can block write methods, but editors get no explanation, scheduled publishing and writes made on `GET` get through, and only some hosts offer one.

Products that keep a site online while writes are frozen document the same range of reasons. These include [GitLab Maintenance Mode](https://docs.gitlab.com/administration/maintenance_mode/), Confluence and Jira Data Center [read-only mode](https://confluence.atlassian.com/doc/using-read-only-mode-for-site-maintenance-952624304.html), [Discourse read-only mode](https://meta.discourse.org/t/read-only-modes-in-discourse/296976), MediaWiki [`$wgReadOnly`](https://www.mediawiki.org/wiki/Manual:$wgReadOnly) and SharePoint's [read-only site lock](https://learn.microsoft.com/en-us/sharepoint/manage-lock-status). They give upgrades, migrations, backups, server moves and maintenance as reasons, and Discourse and MediaWiki also turn the mode on automatically when a database fails over or a replica falls behind. They block writes at one point in the application, with a short allowlist, keep sign-in and the off switch available, and answer a blocked write with a stable error. GitLab and Discourse both use `503`.

Those products also document writes that get through. GitLab and Confluence keep background jobs running, Jira's automation rules and mail handlers keep writing, and the MediaWiki manual warns that `$wgReadOnly` "does not make the database read-only". Databases enforce the boundary where data is written: enabling MySQL's [`read_only`](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_read_only) waits for statements and commits in progress and blocks new transactions until it takes effect. This RFC enforces read-only mode in EmDash's tables for the same reason.

WordPress, Drupal, Craft, Laravel and Heroku use "maintenance mode" for a different feature, which takes the public site offline. Read-only mode keeps it online.

## Example

An administrator freezes a site before moving it to another account.

1. Check which entries are open in the editor:

   ```http
   GET /_emdash/api/admin/read-only
   ```

   ```json
   {
   	"success": true,
   	"data": {
   		"enabled": false,
   		"message": null,
   		"enabledAt": null,
   		"enabledBy": null,
   		"settled": true,
   		"activeEditors": [
   			{
   				"collection": "posts",
   				"entryId": "01JB7Q2V8N3XK5M4T6R9P0W1YZ",
   				"locale": "en",
   				"title": "Quarterly product update",
   				"userId": "01JA3D5F7H9K1M3N5P7R9T1V3X",
   				"userName": "Ana Silva",
   				"acquiredAt": "2026-10-28T09:58:12.000Z"
   			}
   		]
   	}
   }
   ```

2. Ask Ana to finish, then turn the mode on, from the admin, the CLI (`emdash site read-only on --message "…"`) or the API:

   ```http
   PUT /_emdash/api/admin/read-only
   Content-Type: application/json
   X-EmDash-Request: 1

   { "message": "The site is moving to a new account. Editing reopens on the new site." }
   ```

3. Every admin page now shows the message in a banner. If Ana's editor was still open, her next autosave returns:

   ```http
   HTTP/1.1 503 Service Unavailable
   Content-Type: application/json
   ```

   ```json
   {
   	"success": false,
   	"error": {
   		"code": "SITE_READ_ONLY",
   		"message": "This site is read-only",
   		"details": {
   			"message": "The site is moving to a new account. Editing reopens on the new site.",
   			"enabledAt": "2026-10-28T10:02:41.000Z"
   		}
   	}
   }
   ```

   Her editor switches to read-only, and the text she typed stays on screen. In a collaborative editing room, the room's refused save does the same.

4. As soon as the `PUT` returns with `settled: true`, the administrator exports a site package or takes a database backup, imports or restores it into the new deployment, and switches traffic. Writes that were already under way when the mode turned on are refused at the database, so nothing lands after the backup. The old site stays read-only until it is removed, because both deployments can receive traffic while DNS changes.

5. The import didn't carry the flag, so editing is already open on the new site. A raw database backup taken while frozen arrives read-only, and an administrator turns it off after checking the restored site (`DELETE /_emdash/api/admin/read-only` or `emdash site read-only off`).

## Goals

- An administrator can stop and resume every write except the allowlist in one action, from the admin, the CLI or the REST API.
- While the mode is on, the public site, the admin, search, previews, sign-in, site exports and backups keep working, and EmDash can be restarted and upgraded.
- Every write to a guarded table is refused with one stable error code, whatever its source: admin and REST writes, collaborative editing rooms, MCP write tools, plugins (in-process and in both sandbox runtimes), public comment and form submissions, site-transfer imports, the scheduler, and code that writes through `getDb()`.
- The mode applies to work already in progress when it turns on, so an operator never has to wait beyond turning the mode on before taking a backup. On PostgreSQL, turning it on includes waiting for older write transactions to end.
- Signed-in users see the administrator's message, and text typed in an open editor stays on screen.
- Before turning the mode on, the administrator can see which entries are open in the editor outside collaborative editing rooms, and who has them open.
- Writes the HTTP fence already checks gain no database round trip, and logged-out page renders don't change.

## Non-goals

- A visitor-facing offline or maintenance page. Hosts and proxies provide one, and EmDash would need a check on every anonymous request.
- Exempting administrators or other roles from the freeze.
- Scheduled starts, advance-notice banners or automatic expiry.
- Freezing tables that EmDash doesn't create, such as tables a site or a trusted plugin creates for itself. EmDash has no record of them, so it can't add guard triggers to them.
- Freezing object storage directly. A media upload needs database writes to complete, so it stops with the database, but code that writes to the bucket itself isn't stopped. [Failure handling](#failure-handling) covers uploads already in progress.
- Stopping side effects outside the database, such as email, webhooks or calls to external services that a plugin route makes. Its database writes are refused.
- Closing today's gaps in the import and media-usage fences, where plugin media, taxonomy, redirect, KV and storage writes skip the fence. The guard triggers refuse those writes while read-only mode is on.
- A read-only signal that templates and plugins can use to render closed comment boxes and forms. Submissions are refused with a stable code, and a display signal can be added later.
- Moving or copying a site. Site transfer and backups do that; read-only mode makes them safe to run against a live site.

## Detailed design

### Terms

- **Site write fence:** the check in `packages/core/src/transfer/fence.ts` that blocks writes while a site-transfer import runs or media-usage activation is in progress. One SQL statement reads every **fence source**. The HTTP middleware, MCP, plugin capabilities and the scheduler call it.
- **Read-only mode:** a new fence source, set and cleared by an administrator.
- **Guarded table:** a table whose writes read-only mode refuses in the database.
- **Guard trigger:** a database trigger that refuses a write to a guarded table while read-only mode is on.
- **Allowlist:** the writes that continue while read-only mode is on.
- **Exempt route:** an API route the HTTP fence never checks. The exempt routes are the transfer API, the MCP endpoint (which fences each tool instead), dev-only routes, the read-only route, and the sign-in, sign-out and access-removal routes that [Identity changes](#identity-changes) keeps available.

### Behavior

While read-only mode is on, these fail with `503 SITE_READ_ONLY`:

- Every write to a guarded table, from any source.
- Every `POST`, `PUT`, `PATCH` and `DELETE` under `/_emdash/api/` that the HTTP fence covers, except exempt routes, plugin routes and the allowlisted routes. That covers writes to content, media, schema, settings, menus, taxonomies, widgets, sections, redirects, comments and moderation, revisions and WordPress imports. It also covers plugin installs, updates, enabling and uninstalls, which change the code and hooks that run on the site, and saving plugin settings.
- Identity changes other than signing in and removing access, described in [Identity changes](#identity-changes).
- Executing or advancing a site-transfer import, over REST or MCP.
- Collaborative editing saves, and joining a room, described in [Collaborative editing](#collaborative-editing).
- Core MCP tools not annotated `readOnlyHint: true`, apart from the `site_*` transfer tools, as tool errors. Tools that plugins provide run, and their writes are refused like any other plugin write.
- Plugin writes through `ctx` and both sandbox bridges: content, media, comment status, taxonomy terms, redirects, KV, settings and storage, and scheduling or cancelling cron tasks. This applies to plugin routes, hooks and cron tasks alike.
- Public comment and form submissions.
- Scheduled publishing.

Plugin cron pauses, and so do the parts of the hourly system cleanup that write guarded tables.

These keep working:

- Every `GET` and `HEAD` request, including the public site, the admin, search, previews and media.
- Exempt routes, so people can sign in and site exports run as usual.
- Plugin routes, with any method, including the panels and actions that plugins add to the content editor (`/_emdash/api/content/{collection}/{id}/plugin-extensions/…`). Plugins read over `POST`, so their routes stay reachable, and their writes are refused.
- Disabling a plugin, so a misbehaving plugin can be stopped during an incident.
- The read-only allowlist:

  | Route                                                     | Why it stays available                                    |
  | --------------------------------------------------------- | --------------------------------------------------------- |
  | `POST /_emdash/api/content/{collection}/{id}/preview-url` | Signs a preview URL                                       |
  | `POST /_emdash/api/themes/preview`                        | Signs a theme preview URL                                 |
  | `POST /_emdash/api/visual-editing/action-token`           | Renews a signed, stateless token                          |
  | `POST /_emdash/api/site/domain-proof`                     | A read, sent as `POST` so it reaches the primary database |
  | `POST /_emdash/api/settings/backups/archives`             | Takes a backup ("Back up now")                            |

  Other write-method routes that change nothing a freeze protects stay blocked, because a freeze doesn't need them: import probes and analysis, plugin registry verification and test emails. So do changing scheduled-backup settings, deleting a backup archive, and taking, refreshing or releasing an entry edit lock, because an editor is read-only during a freeze. Leases held when the mode turns on lapse within 7 minutes, and an open editor takes its lock again after the freeze if nobody else has.

These writes continue, because operating the freeze, signing in and removing access need them, or because visitors' reads cause them:

- sign-in and sign-out by any method, including `emdash login`, and the sessions, challenges, tokens, rate limits and last-login times they store, including the sign-in state that auth providers such as AT Protocol keep in plugin storage;
- removing access, listed in [Identity changes](#identity-changes), and disabling plugins;
- the read-only state, its audit entries, site exports and backups;
- bookkeeping that reads cause: redirect hit counts, the 404 log, API-token last-used times, search-index repair, redirect artifact repair and the redirect loop cache;
- runtime bookkeeping: the scheduler heartbeat, the site ID that a site's first export creates, secrets generated on first use, the update-check cache, exclusive hook selection and the plugin storage-index sync;
- EmDash's own migrations, described in [Upgrades while frozen](#upgrades-while-frozen).

Nobody bypasses the freeze. When an administrator turns it off, writes resume immediately. Scheduled entries that came due start publishing on the next scheduler tick, and overdue plugin cron tasks run once.

### Identity changes

The identity routes are the routes under `/_emdash/api/auth/`, `/_emdash/api/oauth/`, `/_emdash/api/admin/users/`, `/_emdash/api/admin/api-tokens/`, `/_emdash/api/admin/oauth-clients/` and `/_emdash/api/admin/allowed-domains/`. They are exempt from the transfer and media-usage fence sources, as today. Read-only mode refuses every write under them except signing in and a fixed set of access removals, so an administrator can sign in and lock accounts down during an incident. A route added under these prefixes later is refused until it joins this list. Dev-only routes under them, such as `auth/dev-bypass`, stay exempt.

These stay available:

- signing in and out: passkey and magic-link sign-in, sign-in through an OAuth provider or AT Protocol with an account that is already linked, `auth/handover`, `oauth/authorize`, `oauth/token` and its refresh, and the device flow that `emdash login` uses. Sign-in through an external auth provider, such as Cloudflare Access, still provisions new users and syncs each user's name and role (`packages/core/src/astro/middleware/auth.ts`). That provider decides who has access, and the sync is how a role lowered or an account removed at the provider during an incident reaches EmDash;
- removing access: `oauth/token/revoke`, deleting an API token, deleting an OAuth client, deleting a passkey, and disabling a user (`admin/users/{id}/disable`).

Everything else is refused, including:

- creating invites and completing them (`POST auth/invite`, `auth/invite/register-options`, `auth/invite/complete`) and sign-ups (`auth/signup/request`, `auth/signup/complete`). The links in invite and sign-up emails (`auth/invite/accept`, `auth/signup/verify`) are `GET` requests, so they still open, and the step that creates the account is refused;
- creating or linking an account during OAuth and AT Protocol sign-in. That happens in the provider's `GET` callback, which the HTTP fence doesn't check, so while the mode is on the callbacks sign in only users already linked to that provider account, and otherwise redirect to the sign-in page with a `site_read_only` error. They don't complete an invite carried in the OAuth state, create a user through self-sign-up, or link the provider account to an existing user with the same email (`handleOAuthCallback()` and `findOrCreateOAuthUser()` in `packages/auth/src/oauth/consumer.ts`, called from `packages/core/src/astro/routes/api/auth/oauth/[provider]/callback.ts` and `packages/auth-atproto/src/routes/callback.ts`);
- registering and renaming passkeys;
- sending a recovery link (`admin/users/{id}/send-recovery`). Users can still request a magic link themselves;
- changing a user's role or profile (`PUT admin/users/{id}`) and enabling a user. Disabling a user is the way to lower someone's access during a freeze;
- saving a user's own admin preferences, such as the admin layout (`POST auth/me`);
- creating API tokens, creating or changing OAuth clients, and dynamic client registration (`oauth/register`);
- adding, changing or deleting allowed sign-up domains.

### State

Read-only mode is one row in `options`:

| `name`             | `value`                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `emdash:read_only` | `{ "message": string \| null, "enabledAt": string, "enabledBy": string }` |

`enabledAt` is an ISO 8601 UTC timestamp, and `enabledBy` is a user ID. `message` is plain text, trimmed, with at most 500 characters. It can contain line breaks but no other control characters or bidirectional formatting characters. A missing row means the mode is off, and turning it off deletes the row. A row whose value can't be parsed still counts as on. On PostgreSQL the value also holds `settleXid`, which [Turning the mode on](#turning-the-mode-on) describes.

On SQLite, libSQL and D1, a second row, `emdash:read_only_bypass`, exists only while EmDash's migration runner applies pending migrations. [Upgrades while frozen](#upgrades-while-frozen) describes it.

Both rows are installation state, not site data:

- Site transfer classifies them as `excluded` (`packages/core/src/transfer/format/settings.ts`). Exports leave them out and imports never write them, so an imported site keeps its own state.
- A raw database backup includes `emdash:read_only`, and so does a D1 Time Travel restore to a point during the freeze. A site restored that way starts frozen, which lets the operator check it before reopening editing.

### Guard triggers

A guard trigger runs before each insert, update and delete on a guarded table. While the `emdash:read_only` row exists and no migration bypass applies, it aborts the statement with an error containing `EMDASH_SITE_READ_ONLY`. EmDash already uses triggers this way: migration 081 fences redirect writes with `RAISE(ABORT)` triggers on SQLite and D1 and a plpgsql trigger on PostgreSQL (`packages/core/src/database/migrations/081_redirect_write_guards.ts`), and media-usage capture keeps triggers on every content table (`packages/core/src/media/usage/capture-triggers.ts`).

The guarded tables come from the table classification that site transfer maintains (`packages/core/src/transfer/format/columns.ts`), which a test keeps complete for every migration:

- every `ec_*` content table;
- every other table classified as portable. These hold schema, media records, taxonomies, revisions, bylines, SEO records, menus, widgets, sections, redirects and comments, plus `options`;
- `_plugin_storage`.

These tables aren't guarded:

- tables classified `auth`, `runtime`, `audit`, `migrations` or `derived`;
- `_emdash_transfer_*`, FTS tables and SQLite's internal tables;
- `_plugin_state`, which records whether each plugin is installed and enabled. The request fence controls plugin lifecycle routes, and disabling a plugin has to keep working;
- `_plugin_indexes`, which the plugin storage-index sync writes.

Three guarded tables need narrower triggers. Exact names are compared with `=` and prefixes with `substr()`, because `_` and `%` are wildcards in `LIKE`. An update is skipped only when both its old and its new row are exempt.

- **`options`** holds site settings and plugin KV and settings, which are guarded, as well as bookkeeping that must continue. Its triggers skip these names:
  - `emdash:read_only` and `emdash:read_only_bypass`;
  - `emdash:backups_last_run`, which each scheduled backup writes;
  - `emdash:site_id`, which a site's first export or analysis creates;
  - `system:scheduler:last_completed_at`, the scheduler heartbeat;
  - `emdash:preview_secret` and `emdash:ip_salt`, secrets generated on first use (`packages/core/src/config/secrets.ts`);
  - `emdash:core_update_check`;
  - `_redirect_loop_ids`, the redirect loop cache that the admin's redirects page rebuilds;
  - names starting with `emdash:exclusive_hook:`, which runtime start-up writes when it picks an exclusive hook provider.

  The request fence still refuses the admin routes that write these names as configuration changes, such as choosing an exclusive hook provider.

- **`_plugin_storage`**: the triggers skip rows whose `plugin_id` starts with `auth:`. Auth providers keep sign-in state there; `@emdash-cms/auth-atproto` stores its OAuth state and sessions under `auth:atproto` (`packages/auth-atproto/src/db-store.ts`). Without this exemption, a site that signs in only through AT Protocol couldn't sign in to turn the mode off.

- **`_emdash_redirects`**: recording a visitor's redirect hit sets `hits` and `last_hit_at` (`packages/core/src/database/repositories/redirect.ts`). The update trigger names every other column with `UPDATE OF`, so hits are still recorded. Recording a hit also stops setting `updated_at`. Today every hit changes it, and a running export restarts when a table's latest `updated_at` changes (`packages/core/src/transfer/export/fence.ts`), so an export on a site with redirect traffic can restart again and again. Site packages already leave out `hits` and `last_hit_at`. A migration that adds a column to `_emdash_redirects` adds it to the `UPDATE OF` list. One that drops a column recreates the trigger first, because SQLite refuses to drop a column that a trigger names.

On SQLite, libSQL and D1, each guarded table gets three row-level triggers, and their bodies avoid `CASE … END;`, which the D1 HTTP API that `emdash migrate` uses splits at the inner `END;`. On PostgreSQL, one plpgsql function backs a statement-level trigger on each table, plus `TRUNCATE`, and raises a dedicated SQLSTATE as well as the message. The `options` and `_plugin_storage` triggers are row-level on every dialect because they check the row. On PostgreSQL they use a second function that returns the row, since a `BEFORE` row trigger that returns `NULL` silently skips the write. [Appendix A](#appendix-a-implementation-reference) sketches both dialects.

A migration creates the triggers on every existing guarded table. On PostgreSQL it also creates the functions. The migration can restart after any statement: it uses `CREATE TRIGGER IF NOT EXISTS` on SQLite and drops and recreates on PostgreSQL, as migration 081 does. `SchemaRegistry` creates the triggers in `createContentTable()`, which every path that adds a collection uses, including site-transfer imports. The classification test asserts, after all migrations and on every dialect, that:

- each guarded table has its triggers;
- no other table has them;
- the `_emdash_redirects` column list matches the table.

A migration that rebuilds a table without restoring its triggers fails that test.

A database error that carries the guard's message or SQLSTATE becomes `SITE_READ_ONLY` wherever EmDash turns errors into responses:

- `handleError()`;
- the plugin route wrapper and the hook runner;
- `ctx` and both sandbox bridges;
- MCP's `respondHandlerError()`;
- the scheduler.

The matcher checks the error and its causes. D1 adds its own prefix to the text, so the workerd tests pin down the exact wording D1 returns. [Errors](#errors) describes what a client sees when a handler catches the error itself.

### Turning the mode on

Turning the mode on inserts the `emdash:read_only` row. On SQLite, libSQL and D1, every write runs either before or after that insert, and the guard triggers refuse every write that runs after it. Nothing that started earlier can commit later.

On PostgreSQL, the guard triggers see the row only once the transaction that inserted it commits. A transaction that wrote before that commit can still commit after it. So right after committing the row, `PUT` waits:

1. It reads `settleXid = pg_snapshot_xmax(pg_current_snapshot())`, the first transaction ID not yet assigned. Every transaction that could have written before the row became visible has an ID below it.
2. It records `settleXid` in the row, with an `UPDATE`, so a `DELETE` that ran in between stays.
3. It waits, for up to 30 seconds, until `pg_snapshot_xmin(pg_current_snapshot())` reaches `settleXid`.

Only transactions that have written something have transaction IDs, so readers don't hold up the wait. PostgreSQL normally assigns an ID when a statement changes its first row, which can come long after a statement-level trigger has run. So the guard function first calls `pg_current_xact_id()`, which assigns the ID before the check. If the ID comes before `settleXid`, the wait covers the transaction. If it comes after, the check runs after the row is visible and refuses the write. The wait relies on READ COMMITTED, PostgreSQL's default and the level EmDash uses, where each statement sees rows committed before it started. Snapshot bounds cover every database on the server, so on a server shared with other applications, a long write transaction elsewhere can also delay it. These functions exist on PostgreSQL 13 and later, which covers every version still supported upstream.

`ReadOnlyStatus.settled` reports the result:

- On PostgreSQL, it is `true` once no transaction below `settleXid` is still open. `GET` recomputes it with the same comparison.
- It is `false` when the wait timed out with an older transaction still open.
- It is `false` when `PUT` stopped between committing the row and recording `settleXid`, until another `PUT` records it.
- It is `true` when `settleXid` is above the server's next transaction ID, as after restoring a dump of a frozen database on another server, where no transaction can be older.
- On the other databases it is always `true`.

`emdash site read-only on` and the admin's switch wait until `settled` is `true`. Taking a backup before then can miss that transaction's writes.

### Request fence

**Fence source.** `readSiteWriteFence()` adds `(SELECT value FROM options WHERE name = 'emdash:read_only') AS read_only` to its statement. The Cloudflare sandbox bridge keeps its own copy of the statement (`packages/cloudflare/src/sandbox/bridge.ts`), which gets the same subquery. When several sources apply, the fence reports `TRANSFER_IMPORT_IN_PROGRESS` first, then `SITE_READ_ONLY`, then `MEDIA_USAGE_ACTIVATION_IN_PROGRESS`. The import code comes first because it carries the operation ID and a specific way out (abandon).

**HTTP scope.** The request scope returned by `siteWriteFenceScope()` (`packages/core/src/astro/middleware/media-usage-write-fence.ts`) gains a `readOnly` flag next to `transfer` and `mediaUsage`. The flag is set for every fenced write except plugin routes and the allowlisted routes, so it covers the entry lock route, which today has only the `mediaUsage` flag. The editor-extension routes under `/content` count as plugin routes. The flag is also set for the collaborative editing join route and for writes under the identity routes other than those that [Identity changes](#identity-changes) keeps available, which get no other flag. `/_emdash/api/admin/read-only` joins the exemption list, so the fence never blocks turning the mode off. Plugin lifecycle routes keep calling `checkSiteWriteFence()` after authorization, which reads every source. The disable route passes `{ readOnly: false }`, so disabling a plugin works while frozen and is still refused during an import.

**Exports.** While the mode is on, the HTTP fence and MCP's per-tool fence record no writes for running exports. What they still let through, plugin routes, allowlisted routes and plugin MCP tools, can't change portable data, because the guard triggers refuse those writes. So an export on a frozen site completes while visitors submit plugin forms. When the mode is off, writes are recorded as today, and plugin and allowlisted routes stay fenced during an import. The scopes that only read-only mode adds, for identity routes and the room join, never record writes. A write whose request passed the fence while the mode was on, and that lands after it turns off, isn't recorded.

**Freshness.** The guard triggers read the row on the primary database, inside each write. The request fence reads it without a cache across requests. With D1 sessions on, EmDash sends every non-`GET` request to the primary database (`first-primary`); with sessions off, every query goes to the primary. On Hyperdrive, write requests use the uncached binding. A write that a `GET` request makes, such as a plugin route answering `GET`, never runs the HTTP fence, and the guard trigger refuses it. The flag is never read through `getSiteSettings()`, whose per-isolate cache revalidates every 30 seconds.

### Plugins

**Writes to guarded tables.** Plugin content, media, comment, taxonomy, redirect, KV, settings and storage writes all land in guarded tables, so the guard triggers refuse them, whether they come through `ctx`, either sandbox bridge or `getDb()`. Plugin content writes already read the whole fence first (`beforeContentWrite` in `packages/core/src/plugins/context.ts` and both bridges), so they are refused before they start, as during an import. No other plugin write gains a fence read. `ctx` and both bridges turn the trigger's error into `SiteWriteBlockedError` with the code `SITE_READ_ONLY`, or the matching sandbox route error in a sandboxed plugin. Auth providers write their sign-in state through `createStorageAccess()` too (`getAuthProviderStorage()` in `packages/core/src/api/auth-storage.ts`), and the `_plugin_storage` trigger skips their rows.

**Cron scheduling.** `ctx.cron.schedule()` and `ctx.cron.cancel()` read the `read_only` row and refuse while the mode is on. `_emdash_cron_tasks` isn't a guarded table, because the scheduler writes it.

**Lifecycle.** The routes that install, update, enable and uninstall plugins, and the generic plugin settings route (`PUT /_emdash/api/admin/plugins/{id}/settings`), are refused. Disabling a plugin stays available. `_plugin_state` isn't guarded, so the disable succeeds even though any writes the plugin itself makes while being disabled are refused.

**MCP tools from plugins** run while the mode is on. Plugins register their tools without `readOnlyHint`, so the per-tool fence would otherwise refuse their reads too.

**Hooks during a public render.** A `page:metadata` or `page:fragments` hook that writes has that write refused. The hook runner catches and logs errors per plugin (`packages/core/src/plugins/hooks.ts`), so the page still renders.

Plugin routes already turn `SiteWriteBlockedError` into its status and code (`packages/core/src/plugins/routes.ts`).

### Imports

The transfer API stays exempt, so exports, analysis, status, receipts, cancel and abandon work while frozen. Executing or advancing an import refuses with `SITE_READ_ONLY`, in two places:

- `handleImportExecute()` checks before it consumes an approval or writes an audit entry. It serves `imports/{id}/execute` and the MCP `site_import_start` tool.
- `advanceImport()`, the only path that runs import steps, checks before each step. It serves `imports/{id}/advance` and the MCP `site_import_resume` tool.

Both read the `read_only` value directly rather than through the fence's precedence, because a running import makes the fence report `TRANSFER_IMPORT_IN_PROGRESS` first. An import refused partway stays incomplete, and the REST API, CLI and MCP report `SITE_READ_ONLY`. Resume it after turning the mode off. The guard triggers would refuse the import's writes anyway. These checks refuse it before it consumes an approval or starts a step.

### Collaborative editing

Rooms save through the site write fence on both platforms (`saveContent()` with `fence: true`, in `packages/core/src/rooms/site.ts`), so while the mode is on every room save fails with `SITE_READ_ONLY`. The guard triggers refuse a save already under way, which reports the handler's own error, and the room's next save reports `SITE_READ_ONLY`. A room answers a refused save by broadcasting its `refused` notice, with the code, to every connection. The admin treats a notice with `SITE_READ_ONLY` like a `SITE_READ_ONLY` response: it refetches the manifest, switches the editor to read-only with the typed text kept on screen, and leaves the room.

The join route (`POST /_emdash/api/content/{collection}/{id}/room`) is exempt from today's fence, because joining writes no content. Read-only mode refuses it, so an editor opened during a freeze opens read-only without a room, and a client whose connection reaches its 15-minute lifetime can't rejoin. A join token issued just before the freeze can still open a room for up to a minute, and that room's first refused save switches the editor too. During an import, joining works as today.

Room storage is runtime state, like entry locks: `_emdash_rooms` and `_emdash_room_updates` on Node, and each room's Durable Object storage on Cloudflare. A room keeps the updates it couldn't save there, and a site package or database backup taken during the freeze doesn't contain them, just as it doesn't contain text left on screen in an editor. When a room drops its state while frozen, the recovery revision it writes is refused like any other save, and the room keeps the state. After the freeze, the kept updates save as the draft when an editor rejoins within an hour of the room's last stored update, or as a recovery revision when the room drops its state.

### Scheduler

Node's timer scheduler calls `CronExecutor.tick()` directly and runs `runScheduledMaintenanceTick()` alongside it. The Workers `scheduled()` handler calls `runScheduledTasks()`, which runs both through `runScheduledTasksWithStats()`. Both paths get the check:

- The runtime passes `CronExecutor` a guard. While read-only mode is on, `tick()` claims no tasks and `getNextDueTime()` reports nothing due, so Node's scheduler wakes at the next minute boundary instead of within a second for overdue tasks.
- `runScheduledMaintenanceTick()` reads the fence once. While read-only mode is on, it skips scheduled publishing.
- A sweep that is publishing when the mode turns on has its remaining publishes refused by the guard triggers. Its cursor is an `options` row, so saving it is refused too, and no entry is skipped (`sweepScheduledContent()` in `packages/core/src/scheduled-publish.ts`).
- On Cloudflare, a Cron run waits up to 70 seconds for entries coming due and sweeps again at each one's scheduled time (`publishAtScheduledTimes()`). Each of those sweeps reads the fence first, so a freeze that starts during the wait ends the run at its next wake, without logging an error.
- While frozen, the hourly system cleanup (`packages/core/src/cleanup.ts`) skips its two steps that write guarded tables: removing abandoned pending media and pruning revisions. Its other steps write only unguarded tables and object storage, such as expiring sign-in tokens and removing failed upload attempts, and keep running.
- The heartbeat, scheduled backups and the plugin storage-index sync continue. The data can't change while frozen, so once a scheduled backup has run since the mode turned on (`emdash:backups_last_run` later than `enabledAt` from the tick's fence read, compared as timestamps), `maybeRunScheduledBackup()` (`packages/core/src/api/handlers/backup.ts`) skips the rest. A long freeze then doesn't fill storage with identical archives or prune the ones from before it. "Back up now" works as usual.

Both paths log once when they start skipping and once when they resume, instead of logging an error on every tick. During an import the scheduler behaves as it does today.

Plugin cron pauses, rather than running and having its writes refused, because `CronExecutor` deletes a one-shot task after five failed attempts (backoff from one to 16 minutes). A freeze longer than about half an hour would drop those tasks. Scheduled publishing pauses, rather than running on time, because a copy taken during the freeze publishes the same entry itself. If both copies published it, `content:afterPublish` side effects such as newsletters, webhooks and social posts would run twice.

### Start-up while frozen

Starting a runtime never fails because read-only mode is on. Start-up reads the flag in the `options` `getMany()` call it already makes for site settings, so it gains no query. That read can come from a replica. So when there are newly configured plugins to install, start-up first reads the flag again on the primary database, through a primary session (`first-primary` on D1) rather than the request's session. That happens only after a configuration change. While the mode is on, start-up skips work that writes guarded tables and logs what it skipped:

- **Plugins newly added to the configuration stay disabled.** Start-up doesn't install or activate them (`installUnrecordedConfigPlugins()` in `packages/core/src/emdash-runtime.ts`), because their install and activate hooks write plugin data. Today a configured plugin with no `_plugin_state` row counts as enabled. While frozen it counts as disabled, so its hooks and routes don't run without its install having run.
- **The locale-casing repair waits.** It rewrites `ec_*` rows when the configured locales or the repair version change.

Both run at the first start-up after the mode is off. On Node, that means the next process start. Start-up's other writes go to tables or `options` names that aren't guarded: the FTS repair, the plugin storage-index sync, exclusive hook selection and secrets generated on first use.

### Upgrades while frozen

EmDash's migrations run while read-only mode is on, so a frozen site can be upgraded, including to a security fix, without lifting the freeze. The guard triggers let the migration runner's writes through:

- **PostgreSQL:** EmDash holds a transaction-scoped advisory lock for the whole migration run (`packages/core/src/database/pg-migration-lock.ts`). The guard function looks for that lock in `pg_locks` under its own backend's process ID, and skips the check when it finds it. The exemption covers only the migration's connection and ends with its transaction, including after a crash.
- **SQLite, libSQL and D1:** a trigger can't see which connection is writing, so the runner uses a row instead. It writes the row whenever migrations are pending and the guard-trigger migration has been applied, whether or not the mode is on, so a freeze that starts during a run doesn't strand it. Before that migration there are no triggers to bypass, and on a new install no `options` table yet. Runs with nothing pending, including every ordinary cold start, write nothing.
  - Before each migration, the runner writes `emdash:read_only_bypass` with an expiry 15 minutes ahead, which the database computes (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')`), so the CLI machine's clock doesn't matter.
  - While a run is in progress, the runner refreshes the expiry every five minutes. It does so from a wrapper around the database connection that it hands to the migrator, which writes the refresh between two statements and never during one. Published migrations can't change, so the refresh lives in the runner rather than in each migration.
  - The runner deletes the row when the run ends.
  - The guard triggers skip while the expiry is in the future, so a crashed run leaves them off until it passes.
  - SQLite returns the same `'now'` throughout a statement, so a statement that writes its first row under the bypass writes every row under it, however long it runs.

The request fence, plugin content writes and `ctx.cron` ignore the bypass and keep refusing. During a run on SQLite, libSQL and D1, other plugin writes and code that writes guarded tables directly can write, because only the guard triggers refuse them. The window lasts as long as the run. `emdash migrate` uses the same runner.

### Errors

A refused write returns `503` with the code `SITE_READ_ONLY` and the message `This site is read-only`:

```json
{ "success": false, "error": { "code": "SITE_READ_ONLY", "message": "This site is read-only" } }
```

- **Signed-in callers.** When the request is authenticated, responses from the request fence, the read-only route and MCP add the administrator's message and start time in `error.details`, as in the [Example](#example). That is the same audience the manifest serves. `error.message` stays generic, so the public comment form, which shows it, never displays the administrator's message, even to a signed-in commenter.
- **Anonymous callers** get only the code and the generic message.
- **Writes refused by a guard trigger after passing the request fence.** This happens only to a write already running when the mode turns on. The error mapping reports `SITE_READ_ONLY` where the error reaches it. A handler that catches errors itself answers with its own code, such as `500 CONTENT_UPDATE_ERROR`, and the client's next write gets `SITE_READ_ONLY` from the request fence.
- **Plugins.** `SiteWriteBlockedError` always carries the generic message, because plugin routes return `error.message` to any caller, including anonymous visitors. Sandboxed plugins receive a sandbox route error with the code, so `SandboxRouteErrorCode` gains `SITE_READ_ONLY`. In-process plugins receive `SiteWriteBlockedError`, which core doesn't export. Plugins detect both by checking `error.code === "SITE_READ_ONLY"`.
- **MCP** tools return the code in their usual tool error.
- **The CLI** prints the administrator's message with the error. It treats the code as final rather than retrying it, as it already does for `TRANSFER_IMPORT_IN_PROGRESS`.
- **No `Retry-After` header.** The administrator decides how long the freeze lasts, and clients branch on the code.
- **`TRANSFER_FENCE_CHECK_FAILED`** keeps its meaning: if the fence query fails, the write is refused.

### REST API

All methods on `/_emdash/api/admin/read-only` require `settings:manage` (Admin). An API token also needs the `admin` scope, so a CI or agent token holding only `settings:manage` can't lift a freeze. Session requests send `X-EmDash-Request: 1`, as for every state-changing route.

| Method   | Body                             | Effect                                                                                                                                                                                                    | Response `data`  |
| -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GET`    | None                             | None                                                                                                                                                                                                      | `ReadOnlyStatus` |
| `PUT`    | `{ "message"?: string \| null }` | Turns the mode on and, on PostgreSQL, waits up to 30 seconds for older write transactions to end. If the mode is already on, replaces the message and keeps `enabledAt`, `enabledBy` and any `settleXid`. | `ReadOnlyStatus` |
| `DELETE` | None                             | Turns the mode off. Succeeds when the mode is already off.                                                                                                                                                | `ReadOnlyStatus` |

```ts
interface ReadOnlyStatus {
	enabled: boolean;
	message: string | null;
	enabledAt: string | null;
	enabledBy: { id: string; name: string } | null;
	/** Whether every write transaction older than the switch has ended. */
	settled: boolean;
	activeEditors: Array<{
		collection: string;
		entryId: string;
		locale: string;
		title: string | null;
		userId: string;
		userName: string;
		acquiredAt: string;
	}>;
}
```

`activeEditors` lists the live leases in `_emdash_entry_locks`. A lease lasts 7 minutes and is renewed while an editor is open, until the mode turns on. The lock table has no locale or title, so both come from the entry's row in its collection table, read through the collection's title field, with one query per collection that has open entries. Leases on entries that no longer exist are left out. Collections with edit locking turned off take no leases and never appear, and neither do editors in a collaborative editing room, who hold no lease. Their room's first refused save switches them to read-only.

A `message` over 500 characters, or one containing control or bidirectional formatting characters other than line breaks, returns `400 VALIDATION_ERROR`.

### CLI

`emdash site read-only on [--message <text>]`, `emdash site read-only off` and `emdash site read-only status [--json]` sit next to `emdash site export` and `emdash site import`. They call the REST API with the token that `emdash login` stores, which has the `admin` scope. `on` returns once `settled` is `true`, polling `GET` after the `PUT`. `status` lists the open entries.

### Admin

- The manifest gains `readOnly: { message: string | null; enabledAt: string } | null`, read in the `options` query the manifest route already runs. Only the status endpoint says who turned the mode on.
- The admin shell shows a banner on every page while the mode is on. For administrators, the banner includes a way to turn it off.
- The first-run welcome dialog doesn't open, because dismissing it is a refused write.
- The content editor disables saving, publishing, scheduling and deleting, pauses autosave and doesn't join a collaborative editing room. Text already typed stays on screen.
- Elsewhere in the admin, a `SITE_READ_ONLY` response shows a localized read-only message with the administrator's message from `error.details`, instead of a generic error.
- Any `SITE_READ_ONLY` response, or a room's `refused` notice with that code, makes the admin refetch the manifest, so a page loaded before the freeze switches to the read-only state at its next write. While the mode is on, the admin also refetches the manifest every minute and on window focus, so open tabs see the end of the freeze.
- Settings → General holds the switch and the message field. Before turning the mode on, it shows the open entries from the status endpoint.
- The site export screen suggests turning read-only mode on first when the site is moving.
- Strings go through Lingui, and the layout uses logical properties.

Visual editing on the public site and the public comment form receive the same error. The comment form shows the generic English message unless the site configured its own error label.

### Audit log

Two `AuditAction` values are added: `site_read_only_enable`, also written when the message changes, and `site_read_only_disable`. Each entry has resource type `site_setting`, resource ID `emdash:read_only` and the message in `details`.

## Compatibility and migration

The change is additive:

- One migration creates the guard triggers and, on PostgreSQL, their functions. It is forward-only, can restart after any statement, and leaves existing data untouched. `SchemaRegistry` adds the triggers to content tables it creates afterwards.
- New: the `SITE_READ_ONLY` error code, the `/_emdash/api/admin/read-only` route, the `emdash site read-only` subcommand, an optional manifest field and two audit actions. `SandboxRouteErrorCode` gains a member.

A site that never turns the mode on behaves as before, except for these changes:

1. Every write to a guarded table runs its guard trigger: one primary-key lookup in `options` per written row on SQLite, libSQL and D1, and per statement on PostgreSQL.
2. On SQLite, libSQL and D1, a migration run with pending migrations writes and deletes the `emdash:read_only_bypass` row.
3. Recording a redirect hit no longer changes the redirect's `updated_at`, so hits no longer restart a running export.

The AT Protocol callback's check ships in `@emdash-cms/auth-atproto`. A site that updates `emdash` but keeps an older `@emdash-cms/auth-atproto` still allows self-sign-up and account linking through AT Protocol while frozen, so the changeset tells sites to update both.

While the mode is on, site code that writes EmDash's tables through `getDb()`, such as a view counter on a public page, gets the database error. Tables a site creates itself are unaffected.

The triggers stay in the database after a downgrade. An older EmDash running against a frozen database gets a database error for every write to a guarded table and has no way to turn the mode off. `DELETE FROM options WHERE name = 'emdash:read_only'` turns it off. Turn the mode off before downgrading. When the mode is off, the triggers have no effect on older versions.

## Security and privacy

- Only administrators change the mode, from a session or an `admin`-scoped API token. A token holding only `settings:manage` gets `403`. Session requests need `X-EmDash-Request`.
- The message is plain text written by an administrator, at most 500 characters, with no control or bidirectional formatting characters other than line breaks. The admin renders it as text, and the CLI prints it to a terminal. Signed-in users see it in the manifest and in error details. Anonymous responses and plugin errors never include it.
- The status endpoint, available to administrators only, adds who turned the mode on and who has entries open.
- The guard triggers apply to any code that writes a guarded table, including trusted plugins and site code with direct database access. Code with direct database access can still delete the row, as it can change any other data. Sandboxed plugins can't reach either row, because their KV keys are prefixed with the plugin ID.
- Auth providers' rows in `_plugin_storage` stay writable, so sign-in through them keeps working. While frozen, they sign in only accounts that are already linked.
- The migration bypass covers only the migration's connection on PostgreSQL. On SQLite, libSQL and D1 it is a row that only EmDash's migration runner writes, only while it applies pending migrations, and the request fence, plugin content writes and `ctx.cron` ignore it. During a run, other plugin writes and direct writers can write.
- During an incident freeze, administrators can still sign in, revoke tokens and OAuth clients, delete passkeys, disable users and disable plugins. The freeze refuses every other identity change made through EmDash, including invites, sign-ups, new tokens and role changes. An external auth provider still decides who signs in and with which role.
- Plugin routes keep their own authorization. Read-only mode removes no check from them; it only refuses their writes.
- Exempt routes keep sign-in working, so an administrator can always sign in and turn the mode off. If the fence query fails, the fence refuses the write.
- Enabling and disabling are audited. No public endpoint is added.

## Performance

- A fenced HTTP write still runs one fence query. The new scalar subquery reads one `options` row by primary key, so it adds no round trip.
- Writes under the identity routes that read-only mode refuses gain one fence query, because the fence doesn't check them today. They include the public `oauth/register` and sign-up routes.
- A guard trigger does one primary-key lookup in `options` per written row on SQLite, libSQL and D1, and per statement on PostgreSQL. It runs inside the database, so it adds no round trip, and it runs whether or not the mode is on. Bulk writes, such as an import, pay it on every row.
- Plugin writes gain no fence read, except cron scheduling, which reads the `read_only` row once per call.
- OAuth and AT Protocol sign-in callbacks read the row once, when they would otherwise complete an invite, create a user or link an account.
- Logged-out page renders never run the fence. The only writes they cause are redirect hits, the 404 log and redirect artifact repair, all recorded in `after()` to exempt rows, columns or tables. The query-count snapshot for logged-out routes doesn't change. Public comment submissions already read the fence and gain nothing.
- On PostgreSQL, `PUT` can take up to 30 seconds while older write transactions end, and `GET` runs one snapshot comparison.
- The manifest adds one key to an existing `getMany()` call. While the mode is on, each open admin tab fetches the manifest once a minute.
- The status endpoint runs one `options` read, one lease query joined to users, and one title query per collection with open entries. Only administrators call it.
- The scheduler reads the fence two or three times per tick, plus, on Cloudflare, once per sweep it waits for, outside any request. While frozen, Node's scheduler ticks at most once a minute.
- On SQLite, libSQL and D1, a run with pending migrations writes the bypass row before each migration and every five minutes, and deletes it at the end. Runs with nothing pending write nothing.

## Failure handling

- If the fence query fails, the write gets `503 TRANSFER_FENCE_CHECK_FAILED`, as today, and the client retries.
- If turning the mode on or off fails, the route returns an error and the state is unchanged. The state is a single row, so nothing is half-applied.
- When the mode turns on, the guard triggers refuse the remaining writes of requests that passed the request fence earlier.
  - On SQLite, libSQL and PostgreSQL, a transaction refused this way rolls back.
  - D1 has no transactions, so a multi-statement write in progress at that moment can stop partway, as it would if the Worker were evicted. The site and any backup taken afterwards hold the same state.
  - On PostgreSQL, `PUT` waits for write transactions that started earlier to end, and reports `settled: false` if one is still open after 30 seconds.
  - Imports re-read the fence before each step, so they stop at the next step. A scheduled-publishing sweep's remaining publishes are refused.
  - The client receives `SITE_READ_ONLY` from the error mapping, or the handler's own error when the handler catches it. Its next write gets `SITE_READ_ONLY` from the request fence.
- An upload whose URL was issued before the freeze can still store its object. Confirming the upload is refused, so its media row stays pending or is never written. The system cleanup removes the leftovers after the freeze ends.
- An export on a frozen site restarts if an allowed write changes a table that its consistency check compares, such as an update to a user. It completes on its next pass.
- Start-up doesn't fail because the mode is on. It logs the work it skipped, and that work runs at the first start-up after the mode is off.
- A migration run while frozen bypasses the guard triggers. If it crashes, the bypass ends with the connection on PostgreSQL and when its expiry passes on SQLite, libSQL and D1.
- A bookkeeping write added to EmDash later that targets a guarded table without an exemption fails while frozen and logs the error. It fails closed: nothing is written.
- An administrator who can't load the admin can use the CLI or the REST API. As a last resort, `DELETE FROM options WHERE name = 'emdash:read_only'` turns the mode off.
- Operators can observe the mode through audit entries, one scheduler log line per change of state, the start-up log of skipped work, and the admin banner.

## Verification

- Guard trigger coverage, on SQLite and PostgreSQL after all migrations:
  - every guarded table has its triggers;
  - no other table does;
  - the `_emdash_redirects` column list matches the table.

  This extends `packages/core/tests/integration/transfer/columns.test.ts`, and the workerd tests repeat it on D1.

- In-flight work:
  - a request that passed the request fence before the mode turned on has its next write refused, shown with a test plugin route that pauses between two writes, which receives `SITE_READ_ONLY`;
  - a scheduled-publishing sweep publishes nothing more and skips no entry, and a Cloudflare Cron run waiting for an upcoming entry doesn't publish it;
  - a collaborative editing room's next save is refused, every connected editor switches to read-only with its text kept, and the room saves the kept updates after the mode turns off;
  - on PostgreSQL, a transaction open across the `PUT` delays `settled`, and one held past 30 seconds leaves `settled: false` until it ends;
  - on PostgreSQL, a slow `UPDATE` that starts before the `PUT` and changes its first row after it is either waited for or refused.
- One refused-write test per surface:
  - content, media upload, comment submission and form submission;
  - `execute` and `advance` for an import, over REST and MCP. An `execute` refusal leaves the approval unused;
  - each plugin capability, in-process and in both sandbox bridges (workerd tests), including KV, settings, storage and cron scheduling;
  - an MCP write tool and both scheduler paths;
  - a `getDb()` write to a guarded table;
  - each refused identity change, including `POST auth/me`, and an invite, self-sign-up and account linking through an OAuth provider and through AT Protocol;
  - joining a collaborative editing room, and a room save that a guard trigger refuses after it passed the fence, which keeps its updates;
  - taking, refreshing or releasing an entry edit lock, changing scheduled-backup settings and deleting a backup archive;
  - while frozen, scheduled backups take one archive and then skip until the mode is off.
- Matching allowed tests:
  - sign-in with a passkey, a magic link, an OAuth provider, AT Protocol and `emdash login`;
  - revoking a token, disabling a user and disabling a plugin. Disabling a plugin during an import is still refused;
  - sign-in through an external auth provider that provisions a new user;
  - a preview link and "Back up now";
  - a site export on a site that has never exported, completing while visitors hit redirects;
  - an MCP read tool, a plugin's MCP tool that reads, a plugin route that reads over `POST`, and a plugin's editor panel;
  - a visitor's redirect hit and a 404 log entry, and the admin's redirects page;
  - turning the mode off.
- Start-up while frozen:
  - a site with a newly configured plugin and a pending locale-casing repair boots, serves pages and exports;
  - the new plugin stays disabled, including when the start-up read of the flag is stale;
  - the skipped work runs after the mode turns off.
- Upgrade while frozen, with the bypass interval shortened for the tests:
  - a migration that updates a guarded table completes on each dialect;
  - on SQLite, a plugin content write during the run is still refused;
  - a run that is already going when the mode turns on completes;
  - a run longer than the interval completes, because the runner refreshes the expiry;
  - after a simulated crash, the guard triggers apply again once the bypass expires.
- Restoring a dump of a frozen database (`sqlite3 .dump`, `pg_dump`) succeeds and arrives frozen, and on another PostgreSQL server reports `settled: true`.
- Errors:
  - the workerd tests match the D1 error text for a guard trigger;
  - responses carry the administrator's message only when the request is authenticated;
  - plugin errors keep the generic message;
  - validation rejects control characters.
- Fence tests on SQLite and PostgreSQL (`describeEachDialect`): each source alone and combined, code precedence, the missing-table fallback, `TRANSFER_FENCE_CHECK_FAILED`, a malformed row, the scope flag, the allowlist and plugin-route scoping.
- An import refused partway by read-only mode reports `SITE_READ_ONLY` and resumes after the mode is turned off.
- Saving plugin settings and installing, enabling, updating or uninstalling a plugin are refused.
- While frozen, an export completes while plugin routes, allowlisted routes and plugin MCP tools are called.
- While frozen, Node's scheduler doesn't tick faster than once a minute, and a one-shot cron task keeps its retry count.
- REST: the permission and token-scope checks, validation, idempotent `PUT` and `DELETE`, and the open-entries list, including a lease on a deleted entry.
- The query-count snapshot is unchanged for logged-out routes.
- Admin browser tests:
  - the banner, with the administrator's message;
  - disabled editing;
  - a freeze that starts mid-edit keeps the typed text;
  - a freeze that ends while a tab is open;
  - the layout in Arabic.
- Manual check on Cloudflare: freeze a deployment, then immediately take a D1 Time Travel bookmark and export a site package. Import the package into another deployment, and confirm that the source refused writes throughout and that the bookmark and the package match.

## Rollout and implementation

The feature ships in one minor release, with changesets for these packages:

- `emdash`;
- `@emdash-cms/admin`;
- `@emdash-cms/cloudflare`;
- `@emdash-cms/sandbox-workerd`;
- `@emdash-cms/auth`;
- `@emdash-cms/auth-atproto`.

It needs no feature flag. Until an administrator turns the mode on, it changes only what [Compatibility and migration](#compatibility-and-migration) lists.

1. Guard triggers: the migration, the PostgreSQL functions, `SchemaRegistry` support, the error matcher, the migration bypass, the redirect-hit change and the coverage test.
2. Enforcement:
   - the fence source and scope, export recording and the bridge statement;
   - the identity rules, the OAuth and AT Protocol callback check and the room join refusal;
   - the plugin error mapping and cron check;
   - the import check;
   - the scheduler checks, the cleanup split and the scheduled-backup skip;
   - the start-up rules;
   - the PostgreSQL wait.
3. Controls: the REST route, the CLI subcommand, the audit actions and the manifest field.
4. Admin: the banner, the editor state, including collaborative editing rooms, error messages, the settings switch with open entries, and the export hint.
5. Docs: a read-only mode guide, and a freeze step in the site transfer and backup guides.

[Appendix A](#appendix-a-implementation-reference) lists the files each step touches.

## Alternatives

- **Offline maintenance mode**, as in WordPress, Drupal, Craft, Laravel and Heroku. It takes the public site down, which most of these uses have to avoid, and it needs a check on every anonymous request.
- **An environment variable or integration option.** Changing it needs a deploy or host access, administrators can't change it from the admin, and a database backup doesn't carry it. It could be added later as a force-on override for archived sites.
- **A site setting read through `getSiteSettings()`.** Its 30-second per-isolate cache lets writes through after the mode turns on.
- **Enforcing the mode only in application code**, with every write path calling the fence. Each write path has to remember the call. That is how today's fence gaps arose: plugin media, taxonomy and redirect writes, both bridges' KV and storage writes, and plugin cron on both scheduler paths skip it. Work already past the check keeps writing, so an operator would have to wait an unmeasured time before a backup. A downgrade would also unfreeze the site.
- **Tracking work in progress in EmDash, then turning the mode on.** No registry of in-flight work spans Workers isolates and Node processes. A lease table would cost two primary-database writes on every save, every bridge call and every scheduler step. Crashed or evicted requests leave leases behind, so leases need an expiry, and the wait comes back. During a rolling deploy, isolates on the old version register nothing, so the drain could report "done" early. Media-usage activation met the same limit and asks the operator to confirm that writers are drained. On PostgreSQL the database already tracks open write transactions, and [Turning the mode on](#turning-the-mode-on) uses that.
- **Re-checking before each step and verifying with a snapshot.** A `captureFence()` snapshot (row counts, latest `updated_at` and largest ID per table) taken when the mode turns on can show that something changed since, but it can't stop the change. Once a late write lands, the snapshot never matches again. Writes that must continue still change tables it compares. User updates through the auth adapter set `users.updated_at`, for example, so the snapshot reports changes even when nobody edited anything. It also misses writes from code with direct database access, and a downgrade still unfreezes the site. This design keeps the per-step re-checks.
- **A database switch.** D1 has none. PostgreSQL's `default_transaction_read_only` and SQLite's `PRAGMA query_only` are per-session defaults that any client can change, and Turso's `block_writes` exists only on Turso. All of them also refuse the allowlisted writes, including sign-in and turning the mode off, and none returns a useful error.
- **An advisory-lock barrier on PostgreSQL.** Write statements could take a shared advisory lock and turning the mode on an exclusive one, so turning it on waits for write transactions in progress to commit. Every write would pay for the lock, and because PostgreSQL queues lock requests fairly, a long transaction would stall every site write behind the switch until a lock timeout. Waiting on the transaction snapshot gives the same guarantee without either cost.
- **Edge rules only.** Editors get no explanation, scheduled publishing and writes made on `GET` get through, and the rules depend on the host.
- **Fencing every plugin route by HTTP method.** Plugins read over `POST`. The forms plugin lists forms and serves its public form definition that way, and the admin loads Portable Text field options the same way. Blocking those requests would break plugin pages and embedded forms while the site is frozen.
- **Letting plugin routes declare themselves read-only.** It would need a new plugin API and an update to every plugin. The guard triggers cover plugin writes without either.
- **Exempting administrators,** as Discourse's staff-writes-only mode and Jira's system-administrator exemption do. An administrator's edits are lost in a move like anyone else's. Jira also documents that its permission-layer enforcement lets automation rules and mail handlers write.
- **Freezing only while an export runs.** Discourse [removed](https://meta.discourse.org/t/when-to-use-readonly-mode-during-backup/136009) its equivalent in 2020. A move needs the freeze until traffic switches, and the export already restarts when portable data changes.
- **Locking or demoting users.** These are writes themselves, someone has to undo them, and tokens, plugins and the scheduler keep writing.

## Drawbacks

- The guard triggers add schema. That means a migration, triggers on every guarded table written for two dialects, and upkeep whenever a table is added or rebuilt, which a test enforces.
- The exempt `options` names are a hand-kept list. A bookkeeping option that EmDash adds later and writes while frozen fails until the list includes it.
- On D1, a multi-statement write in progress when the mode turns on can stop partway.
- On PostgreSQL, turning the mode on can take up to 30 seconds, and a write transaction held open longer leaves `settled: false` until it ends. On a server shared with other applications, their transactions count too.
- Tables that EmDash doesn't create aren't frozen. Object storage is frozen only through the database writes that uploads need.
- Site code that writes EmDash's tables on public pages fails while frozen.
- Scheduled entries publish late and plugin cron runs late. After a long freeze, overdue entries publish together over the first ticks, up to 100 per collection each. Cron tasks that only call external services wait too.
- Comment and form submissions are refused, not queued, and public forms show an error.
- Newly configured plugins stay disabled, and locale-casing repairs wait, until a start-up after the mode is off. On Node, that is the next process start.
- Sign-in, access removal and bookkeeping still write. In a raw database move, such changes made after the backup are lost.
- On SQLite, libSQL and D1, plugin writes other than content, and code that writes guarded tables directly, can write while a migration runs on a frozen site.
- The `_emdash_redirects` trigger lists its columns, so migrations that add or drop a redirect column must update it.
- A write already running when the mode turns on can fail with its handler's own error rather than `SITE_READ_ONLY`.
- A forgotten freeze blocks editing until someone turns it off. The banner shows when it started.
- The open-entries list leaves out editors in collaborative editing rooms.

## Open questions

- A Maintainer sponsor.

## Appendix A: Implementation reference

### Fence statement

```sql
SELECT
	(SELECT state FROM _emdash_media_usage_activation WHERE task_key = 'incremental_capture') AS media_state,
	(SELECT id FROM _emdash_transfer_operations
		WHERE kind = 'import'
			AND (state IN ('running', 'verifying')
				OR (state IN ('failed', 'cancelled') AND mutation_started_at IS NOT NULL))
		LIMIT 1) AS import_id,
	(SELECT id FROM _emdash_transfer_operations WHERE kind = 'export' AND state = 'running' LIMIT 1) AS export_id,
	(SELECT value FROM options WHERE name = 'emdash:read_only') AS read_only
```

### Guard triggers

On SQLite, libSQL and D1, each guarded table gets an insert, an update and a delete trigger:

```sql
CREATE TRIGGER IF NOT EXISTS emdash_read_only_ec_posts_insert
BEFORE INSERT ON ec_posts
BEGIN
	SELECT RAISE(ABORT, 'EMDASH_SITE_READ_ONLY')
	WHERE EXISTS (SELECT 1 FROM options WHERE name = 'emdash:read_only')
		AND NOT EXISTS (
			SELECT 1 FROM options
			WHERE name = 'emdash:read_only_bypass'
				AND json_extract(value, '$.until') > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		);
END
```

The triggers on `options` and `_plugin_storage` add a `WHEN` clause that skips exempt rows. It checks `NEW` on insert and `OLD` on delete. On update, the write is skipped only when both `OLD` and `NEW` are exempt. For example:

```sql
CREATE TRIGGER IF NOT EXISTS emdash_read_only_options_update
BEFORE UPDATE ON options
WHEN NOT (emdash_exempt(OLD.name) AND emdash_exempt(NEW.name))
BEGIN
	-- same body as above
END
```

`emdash_exempt(name)` stands for the test that is written out inline, `name IN ('emdash:read_only', …) OR substr(name, 1, 22) = 'emdash:exclusive_hook:'`, because D1 doesn't support user-defined SQL functions.

On PostgreSQL, one function backs a statement-level trigger on each guarded table:

```sql
CREATE OR REPLACE FUNCTION emdash_read_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_current_xact_id();
	IF EXISTS (SELECT 1 FROM options WHERE name = 'emdash:read_only') THEN
		IF NOT EXISTS (
			SELECT 1 FROM pg_locks
			WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
				AND classid = <migration lock id, high 32 bits>
				AND objid = <migration lock id, low 32 bits>
				AND objsubid = 1
		) THEN
			RAISE EXCEPTION 'EMDASH_SITE_READ_ONLY' USING ERRCODE = '<dedicated SQLSTATE>';
		END IF;
	END IF;
	RETURN NULL;
END;
$$;

CREATE TRIGGER emdash_read_only_guard
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ec_posts
FOR EACH STATEMENT EXECUTE FUNCTION emdash_read_only_guard();
```

The nested `IF` reads `pg_locks` only while the mode is on. A statement-level trigger's return value is ignored. The row-level triggers on `options` and `_plugin_storage` use a second function, which also starts with `pg_current_xact_id()` and makes the same check, and ends with `RETURN COALESCE(NEW, OLD)`, because a `BEFORE` row trigger that returns `NULL` skips the row's write.

After committing the row and recording `settleXid = pg_snapshot_xmax(pg_current_snapshot())`, `PUT` on PostgreSQL repeats this query until it returns `true` or 30 seconds pass. `GET` runs it once:

```sql
SELECT pg_snapshot_xmin(pg_current_snapshot()) >= $settleXid::xid8
	OR $settleXid::xid8 > pg_snapshot_xmax(pg_current_snapshot()) AS settled
```

### Types

```ts
type SiteWriteFenceCode =
	| "MEDIA_USAGE_ACTIVATION_IN_PROGRESS"
	| "MEDIA_USAGE_ACTIVATION_CHECK_FAILED"
	| "TRANSFER_IMPORT_IN_PROGRESS"
	| "TRANSFER_FENCE_CHECK_FAILED"
	| "SITE_READ_ONLY";

interface SiteWriteFenceScope {
	mediaUsage?: boolean;
	transfer?: boolean;
	readOnly?: boolean;
}

interface SiteWriteRequestScope {
	transfer: boolean;
	mediaUsage: boolean;
	readOnly: boolean;
	recordWrite: boolean;
}
```

### Files by step

| Step        | Change                                                                                   | Files                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard       | Migration, function, trigger SQL and exempt names                                        | A new migration in `packages/core/src/database/migrations/`, registered in `runner.ts`; `packages/core/src/database/read-only-guard.ts`                                                                                                                                                                                                                                                            |
| Guard       | New content tables                                                                       | `packages/core/src/schema/registry.ts` (`createContentTable()`)                                                                                                                                                                                                                                                                                                                                    |
| Guard       | Migration bypass                                                                         | `packages/core/src/database/migrations/runner.ts`                                                                                                                                                                                                                                                                                                                                                  |
| Guard       | Error matcher and mapping                                                                | `packages/core/src/api/error.ts`, `packages/core/src/plugins/context.ts`, `packages/core/src/plugins/routes.ts`, `packages/core/src/plugins/hooks.ts`, `packages/core/src/mcp/server.ts`, `packages/cloudflare/src/sandbox/bridge.ts`, `packages/workerd/src/sandbox/bridge-handler.ts`                                                                                                            |
| Guard       | Coverage test                                                                            | `packages/core/tests/integration/transfer/columns.test.ts`                                                                                                                                                                                                                                                                                                                                         |
| Guard       | Redirect hits                                                                            | `packages/core/src/database/repositories/redirect.ts` (`recordHit()`)                                                                                                                                                                                                                                                                                                                              |
| Enforcement | Fence source, precedence and the missing-table fallback                                  | `packages/core/src/transfer/fence.ts`, `packages/cloudflare/src/sandbox/bridge.ts`                                                                                                                                                                                                                                                                                                                 |
| Enforcement | Error code, status, details and retry handling                                           | `packages/core/src/transfer/errors.ts`, `packages/core/src/plugins/sandbox/types.ts`, `packages/cloudflare/src/sandbox/wrapper.ts`, `packages/workerd/src/sandbox/wrapper.ts`, `packages/core/src/cli/site/shared.ts`                                                                                                                                                                              |
| Enforcement | Scope flag, allowlist, identity rules, room join, plugin-route scoping, export recording | `packages/core/src/astro/middleware/media-usage-write-fence.ts`, `packages/core/src/mcp/server.ts` (per-tool fence, plugin tools)                                                                                                                                                                                                                                                                  |
| Enforcement | Invites, self-sign-up and account linking during OAuth and AT Protocol sign-in           | `packages/auth/src/oauth/consumer.ts`, `packages/core/src/astro/routes/api/auth/oauth/[provider]/callback.ts`, `packages/auth-atproto/src/routes/callback.ts`                                                                                                                                                                                                                                      |
| Enforcement | Import check                                                                             | `packages/core/src/api/handlers/transfer.ts` (`handleImportExecute()`), `packages/core/src/transfer/import/advance.ts` (`advanceImport()`)                                                                                                                                                                                                                                                         |
| Enforcement | Plugin cron scheduling                                                                   | `packages/core/src/plugins/context.ts`, `packages/core/src/plugins/cron.ts`, `packages/cloudflare/src/sandbox/bridge.ts`, `packages/workerd/src/sandbox/bridge-handler.ts`                                                                                                                                                                                                                         |
| Enforcement | Scheduler, cleanup and start-up                                                          | `packages/core/src/plugins/cron.ts`, `packages/core/src/scheduled-publish.ts`, `packages/core/src/cleanup.ts`, `packages/core/src/api/handlers/backup.ts` (`maybeRunScheduledBackup()`), `packages/core/src/emdash-runtime.ts` (`runScheduledMaintenanceTick`, `publishScheduledWithFence`, `publishAtScheduledTimes`, scheduler wiring, `installUnrecordedConfigPlugins()`, locale-casing repair) |
| Controls    | Route and handler, including the PostgreSQL wait                                         | `packages/core/src/astro/routes/api/admin/read-only.ts`, `packages/core/src/api/handlers/read-only.ts`                                                                                                                                                                                                                                                                                             |
| Controls    | Audit actions                                                                            | `packages/core/src/database/repositories/audit.ts`                                                                                                                                                                                                                                                                                                                                                 |
| Controls    | Manifest field                                                                           | `packages/core/src/astro/routes/api/manifest.ts`, `packages/core/src/astro/types.ts`                                                                                                                                                                                                                                                                                                               |
| Controls    | CLI                                                                                      | `packages/core/src/cli/commands/site.ts`                                                                                                                                                                                                                                                                                                                                                           |
| Admin       | Banner, editor state, room notice, error messages, settings, export hint                 | `packages/admin/src/components/Shell.tsx`, `packages/admin/src/router.tsx`, `packages/admin/src/lib/api/client.ts`, `packages/admin/src/lib/co-editing/replica/connection.ts`, `packages/admin/src/components/settings/GeneralSettings.tsx`, `packages/admin/src/components/settings/transfer/ExportSection.tsx`                                                                                   |
| Docs        | Guide and freeze steps                                                                   | `docs/src/content/docs/guides/`, `guides/site-transfer.mdx`, `guides/backups.mdx`, the REST API and CLI references                                                                                                                                                                                                                                                                                 |
