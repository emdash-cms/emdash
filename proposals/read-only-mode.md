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

Read-only mode lets an administrator stop every write to a site's content and configuration while the public site and the admin stay readable. While it is on, editors can sign in and read. Writes to site data and configuration through the admin, the REST API, MCP, plugins and the scheduler fail with `503 SITE_READ_ONLY`.

The state is one row in the `options` table. That row becomes a new source for the existing site write fence, which already blocks writes during a site-transfer import. Enforcement reuses the fence's single query and the write paths it already covers. HTTP writes gain no round trip, and logged-out page renders don't read the fence at all.

## Problem and user case

To move a production site to another Cloudflare account, an operator backs up the database, copies the media, re-creates the Worker and switches traffic. Edits made after the backup are lost, so editing has to stop from the backup until the new deployment serves traffic, and visitors have to keep reading the site throughout. EmDash gives the operator no way to enforce that. The freeze depends on every editor seeing a chat message, and an editor who misses it loses their work. Restores, incidents and a database close to its size limit raise the same need.

The request has come up before. Ideas Discussion [#2022](https://github.com/emdash-cms/emdash/discussions/2022) asks for an admin setting that locks the dashboard to read-only. Issue [#2206](https://github.com/emdash-cms/emdash/issues/2206) asks for a toggle, available only to admins, that "would prevent any updates to any part of your EmDash site … especially when you have a lot of folks in your dashboard who might not all be easily reachable via chat".

Today's workarounds each leave writes open:

- Asking editors to stop depends on everyone reading the message.
- Demoting roles or disabling users is itself a set of writes that someone has to undo. API tokens, plugins and scheduled publishing keep writing.
- An edge rule can block write methods, but editors get no explanation, scheduled publishing and writes made on `GET` get through, and only some hosts offer one.

Products that keep a site online while writes are frozen have converged on one shape. These include [GitLab Maintenance Mode](https://docs.gitlab.com/administration/maintenance_mode/), Confluence and Jira Data Center [read-only mode](https://confluence.atlassian.com/doc/using-read-only-mode-for-site-maintenance-952624304.html), [Discourse read-only mode](https://meta.discourse.org/t/read-only-modes-in-discourse/296976) and MediaWiki [`$wgReadOnly`](https://www.mediawiki.org/wiki/Manual:$wgReadOnly). They block writes at one point, with a short allowlist. They keep sign-in and the off switch available, and they answer a blocked write with a stable error; GitLab and Discourse both use `503`.

WordPress, Drupal, Craft, Laravel and Heroku use "maintenance mode" for a different feature, which takes the public site offline. A site move needs the opposite.

## Example

An administrator freezes a site before moving it.

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

   { "success": false, "error": { "code": "SITE_READ_ONLY", "message": "This site is read-only" } }
   ```

   Her editor switches to read-only, and the text she typed stays on screen.

4. After a minute, so that requests and scheduler work already in progress have finished, the administrator exports a site package, imports it into the new deployment and switches traffic. The old site stays read-only until it is removed, because both deployments can receive traffic while DNS changes.

5. The import didn't carry the flag, so editing is already open on the new site. A raw database backup taken while frozen would arrive read-only, and an administrator turns it off after checking the restored site (`DELETE /_emdash/api/admin/read-only` or `emdash site read-only off`).

## Goals

- An administrator can stop and resume all writes to site content and configuration in one action, from the admin, the CLI or the REST API.
- While the mode is on, the public site, the admin, search, previews, sign-in, site exports, backups and plugin features that don't change site data or configuration keep working.
- Every write to site data that EmDash controls refuses with one stable error code. That covers admin and REST writes, MCP write tools, plugin writes to site data (in-process and sandboxed), public comment submissions, site-transfer imports and scheduled publishing.
- Editors can see that the site is read-only, and text typed in an open editor stays on screen.
- Before turning the mode on, the administrator can see which entries are open in the editor and who has them open.
- HTTP writes gain no database round trip, and logged-out page renders don't change.

## Non-goals

- A visitor-facing offline or maintenance page. Hosts and proxies provide one, and EmDash would need a check on every anonymous request.
- Exempting administrators or other roles from the freeze.
- Scheduled starts, advance-notice banners or automatic expiry.
- Blocking writes from code outside EmDash's APIs, such as a site endpoint that calls `getDb()` or a trusted plugin that writes to the database directly.
- Blocking a plugin's writes to its own KV, storage and settings. Site packages never contain them.
- Moving or copying a site. Site transfer and backups do that; this RFC makes them safe to run against a live site.

## Detailed design

### Terms

- **Site write fence:** the check in `packages/core/src/transfer/fence.ts` that blocks writes while a site-transfer import runs or media-usage activation is in progress. One SQL statement reads every **fence source**.
- **Read-only mode:** a new fence source, set and cleared by an administrator.
- **Exempt route:** an API route the HTTP fence never checks. The exempt routes are sign-in, sign-out and identity management (users, API tokens, OAuth clients, allowed domains), the OAuth and well-known endpoints, the transfer API, the MCP endpoint (which fences each tool instead), dev-only routes, entry edit locks and, with this RFC, the read-only route.
- **Site data:** the records a site package carries, such as content and revisions, media, taxonomies, menus, widgets, sections, redirects, comments, bylines, SEO records, schema and portable settings.

### Behavior

While read-only mode is on, these fail with `503 SITE_READ_ONLY`:

- Every `POST`, `PUT`, `PATCH` and `DELETE` under `/_emdash/api/` that the fence covers today, except exempt routes, plugin routes and the read-only allowlist. That covers writes to content, media, schema, settings, menus, taxonomies, widgets, sections, redirects, comments and moderation, revisions and WordPress imports. It also covers plugin installs, updates, enabling, disabling and uninstalls, which change the code and hooks that run on the site, and saving plugin settings, which is a configuration change.
- Executing or advancing a site-transfer import, over REST or MCP.
- MCP tools not annotated `readOnlyHint: true`, apart from the `site_*` transfer tools, as tool errors.
- Plugin writes to site data through `ctx` or the sandbox bridge: content, media, comment status, taxonomy terms and redirects. This applies to plugin routes, hooks and cron tasks alike.
- Scheduled publishing.

Plugin cron and the hourly system cleanup pause. The scheduler heartbeat, scheduled backups and the once-per-process plugin storage-index sync continue.

These keep working:

- Every `GET` and `HEAD` request, including the public site, the admin, search, previews and media.
- Exempt routes, so sign-in works and site exports run as usual.
- Plugin routes, with any method. Their writes to site data are refused by the plugin-capability guard, so plugins that read over `POST` or write only their own storage keep working. The generic plugin settings route (`PUT /_emdash/api/admin/plugins/{id}/settings`) is refused, as listed above. A plugin that saves its settings through its own route and `ctx` keeps saving, because those are writes to its own settings.
- The read-only allowlist: creating a preview link, renewing a visual-editing action token, signing a theme preview, reading a domain proof, and changing backup settings and archives.

These writes continue, because they hold no site data:

- A plugin's writes to its own KV, storage and settings, such as form submissions stored by a forms plugin.
- Sessions, sign-in tokens and user, API-token and OAuth-client changes.
- Bookkeeping that reads cause: redirect hit counts, the 404 log, API-token last-used times and search-index repair.
- Work deferred with `after()` by a request that passed the fence before the mode turned on.

Nobody bypasses the freeze. When an administrator turns it off, writes resume immediately. Scheduled entries that came due publish on the next scheduler tick, and overdue plugin cron tasks run once.

### State

Read-only mode is one row in `options`:

| `name`             | `value`                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| `emdash:read_only` | `{ "message": string \| null, "enabledAt": string, "enabledBy": string }` |

`enabledAt` is an ISO 8601 UTC timestamp, and `enabledBy` is a user ID. `message` is plain text, trimmed, with at most 500 characters. A missing row means the mode is off, and turning it off deletes the row. A row whose value can't be parsed still counts as on.

The row is installation state, not site data:

- Site transfer classifies it as `excluded` (`packages/core/src/transfer/format/settings.ts`). Exports leave it out and imports never write it, so an imported site keeps its own state.
- A raw database backup includes it, and so does a D1 Time Travel restore to a point during the freeze. A site restored that way starts frozen, which lets the operator check it before reopening editing.

### Enforcement

**Fence source.** `readSiteWriteFence()` adds `(SELECT value FROM options WHERE name = 'emdash:read_only') AS read_only` to its statement. The sandbox bridge keeps its own copy of the statement (`packages/cloudflare/src/sandbox/bridge.ts`), which gets the same subquery. When several sources apply, the fence reports `TRANSFER_IMPORT_IN_PROGRESS` first, then `SITE_READ_ONLY`, then `MEDIA_USAGE_ACTIVATION_IN_PROGRESS`. The import code comes first because it carries the operation ID and a specific way out (abandon).

**HTTP scope.** The request scope returned by `siteWriteFenceScope()` (`packages/core/src/astro/middleware/media-usage-write-fence.ts`) gains a `readOnly` flag next to `transfer` and `mediaUsage`. The flag is set for every fenced write except plugin routes (`/_emdash/api/plugins/`) and the read-only allowlist:

| Route                                                     | Why it changes no site data                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /_emdash/api/content/{collection}/{id}/preview-url` | Signs a preview URL                                               |
| `POST /_emdash/api/themes/preview`                        | Signs a theme preview URL                                         |
| `POST /_emdash/api/visual-editing/action-token`           | Renews a signed, stateless token                                  |
| `POST /_emdash/api/site/domain-proof`                     | A read, sent as `POST` so it reaches the primary database         |
| `/_emdash/api/settings/backups` and paths below it        | Backup settings and archives, which a freeze must leave available |

Other write-method routes that change no site data stay blocked, because a freeze doesn't need them: import probes and analysis, plugin registry verification and test emails.

Plugin routes and allowlisted routes don't count as writes for running exports (`recordWrite: false`). A plugin route that writes site data records the write through the plugin-capability guard instead. Site packages never contain plugin data, so an export restarts only when site data changes. Both kinds of route stay fenced during an import, as today.

`/_emdash/api/admin/read-only` joins the exemption list, so the fence never blocks turning the mode off. Plugin lifecycle routes keep calling `checkSiteWriteFence()` after authorization, which reads every source.

**Imports.** The transfer API stays exempt, so exports, analysis, status, receipts, cancel and abandon work while frozen. Executing or advancing an import refuses with `SITE_READ_ONLY`, in two places:

- `handleImportExecute()` checks before it consumes an approval or writes an audit entry. It serves `imports/{id}/execute` and the MCP `site_import_start` tool.
- `advanceImport()`, the only path that runs import steps, checks before each step. It serves `imports/{id}/advance` and the MCP `site_import_resume` tool.

Both read the `read_only` value directly rather than through the fence's precedence, because a running import makes the fence report `TRANSFER_IMPORT_IN_PROGRESS` first. An import refused partway stays incomplete, and the REST API, CLI and MCP report `SITE_READ_ONLY`. Resume it after turning the mode off.

**Plugin writes.** Today `beforeContentWrite` guards only content writes from plugins: content methods on `ctx` in `packages/core/src/plugins/context.ts`, and `contentCreate`, `contentUpdate` and `contentDelete` in the sandbox bridge. It becomes a site-write guard that also runs before plugin media writes, comment status changes, taxonomy term writes and redirect writes, both in-process and in the bridge. A blocked call throws `SiteWriteBlockedError`; in a sandboxed plugin it raises the matching sandbox route error. Plugin routes already turn that error into its status and code (`packages/core/src/plugins/routes.ts`). After each successful guarded write, the guard records the write for running exports. A plugin's KV, storage and settings writes stay unguarded.

**Fallback.** When a fence table is missing, which happens on a database with pending migrations, `readSiteWriteFence()` falls back to checking media-usage activation alone, and the bridge skips the check entirely when the media-usage table is missing. Both fallbacks also read `emdash:read_only`, so the freeze never fails open.

**Freshness.** The fence reads the row without a cache across requests. With D1 sessions on, EmDash sends every non-`GET` request to the primary database (`first-primary`); with sessions off, every query goes to the primary. On Hyperdrive, write requests use the uncached binding. A freeze therefore applies to the next API write in every isolate and process. A write that starts from a `GET` request, such as a plugin route answering `GET`, reads through that request's session, so it can see a replica's lag. The flag is never read through `getSiteSettings()`, whose per-isolate cache revalidates every 30 seconds.

### Scheduler

Node's timer scheduler calls `CronExecutor.tick()` directly and runs `runScheduledMaintenanceTick()` alongside it. The Workers `scheduled()` handler calls `runScheduledTasks()`, which runs both through `runScheduledTasksWithStats()`. Both paths get the check:

- The runtime passes `CronExecutor` a guard. While read-only mode is on, `tick()` claims no tasks and `getNextDueTime()` reports nothing due, so Node's scheduler re-arms at its 60-second maximum instead of its 1-second minimum for overdue tasks.
- `runScheduledMaintenanceTick()` reads the fence once and passes the result to scheduled publishing. While read-only mode is on, it skips scheduled publishing and the system cleanup, which prunes revisions. It keeps the heartbeat, scheduled backups and the storage-index sync.

Both log once when they start skipping and once when they resume, instead of logging an error on every tick. During an import the scheduler behaves as it does today.

Plugin cron pauses, rather than running and having its site-data writes refused, because `CronExecutor` deletes a one-shot task after five failed attempts (backoff from one to 16 minutes). A freeze longer than about half an hour would drop those tasks. Scheduled publishing pauses, rather than running on time, because a copy taken during the freeze publishes the same entry itself. If both copies published it, `content:afterPublish` side effects such as newsletters, webhooks and social posts would run twice.

### Errors

A refused write returns:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{ "success": false, "error": { "code": "SITE_READ_ONLY", "message": "This site is read-only" } }
```

- The response has no `Retry-After` header. The administrator decides how long the freeze lasts, and clients branch on the code.
- Error bodies never include the administrator's message, because anonymous comment submissions receive them.
- MCP tools return the code in their usual tool error. Sandboxed plugins receive a sandbox route error with the code, so `SandboxRouteErrorCode` gains `SITE_READ_ONLY`. In-process plugins receive `SiteWriteBlockedError`, which core doesn't export. Plugins detect both by checking `error.code === "SITE_READ_ONLY"`.
- The CLI treats the code as final rather than retrying it, as it already does for `TRANSFER_IMPORT_IN_PROGRESS`.
- `TRANSFER_FENCE_CHECK_FAILED` keeps its meaning: if the fence query fails, the write is refused.

### REST API

All methods on `/_emdash/api/admin/read-only` require `settings:manage` (Admin). An API token also needs the `admin` scope, so a CI or agent token holding only `settings:manage` can't lift a freeze. Session requests send `X-EmDash-Request: 1`, as for every state-changing route.

| Method   | Body                             | Effect                                                                                             | Response `data`  |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| `GET`    | None                             | None                                                                                               | `ReadOnlyStatus` |
| `PUT`    | `{ "message"?: string \| null }` | Turns the mode on. If it's already on, replaces the message and keeps `enabledAt` and `enabledBy`. | `ReadOnlyStatus` |
| `DELETE` | None                             | Turns the mode off. Succeeds when the mode is already off.                                         | `ReadOnlyStatus` |

```ts
interface ReadOnlyStatus {
	enabled: boolean;
	message: string | null;
	enabledAt: string | null;
	enabledBy: { id: string; name: string } | null;
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

`activeEditors` lists the live leases in `_emdash_entry_locks`. A lease lasts 7 minutes and is renewed while an editor is open. The lock table has no locale or title, so both come from the entry's row in its collection table, read through the collection's title field, with one query per collection that has open entries. Leases on entries that no longer exist are left out. Collections with edit locking turned off take no leases and never appear. A `message` over 500 characters returns `400 VALIDATION_ERROR`.

### CLI

`emdash site read-only on [--message <text>]`, `emdash site read-only off` and `emdash site read-only status [--json]` sit next to `emdash site export` and `emdash site import`. They call the REST API with the token that `emdash login` stores, which has the `admin` scope. `status` lists the open entries.

### Admin

- The manifest gains `readOnly: { message: string | null; enabledAt: string } | null`, read in the `options` query the manifest route already runs. Only the status endpoint says who turned the mode on.
- The admin shell shows a banner on every page while the mode is on. For administrators, the banner includes a way to turn it off.
- The content editor disables saving, publishing, scheduling and deleting, and pauses autosave. Text already typed stays on screen.
- Elsewhere in the admin, a `SITE_READ_ONLY` response shows a localized read-only message instead of a generic error.
- Any `SITE_READ_ONLY` response makes the admin refetch the manifest, so a page loaded before the freeze switches to the read-only state at its next write. While the mode is on, the admin also refetches the manifest every minute and on window focus, so open tabs see the end of the freeze.
- Settings → General holds the switch and the message field. Before turning the mode on, it shows the open entries from the status endpoint.
- The site export screen suggests turning read-only mode on first when the site is moving.
- Strings go through Lingui, and the layout uses logical properties.

Visual editing on the public site and the public comment form receive the same error. The comment form shows the server's English message unless the site configured its own error label.

### Audit log

Two `AuditAction` values are added: `site_read_only_enable`, also written when the message changes, and `site_read_only_disable`. Each entry has resource type `site_setting`, resource ID `emdash:read_only` and the message in `details`.

### Pending proposals

The real-time co-editing RFC ([#4267](https://github.com/emdash-cms/emdash/pull/4267), pending) applies the site write fence to room saves. Under read-only mode those saves fail with `SITE_READ_ONLY` and count as failed saves. Its join route ignores the fence, so clients could keep editing in a room that can't save. Whichever of the two features is implemented second makes the join route report read-only mode, so clients open read-only.

## Compatibility and migration

The change is additive:

- No schema migration. The state is a row in the existing `options` table.
- New: the `SITE_READ_ONLY` error code, the `/_emdash/api/admin/read-only` route, the `emdash site read-only` subcommand, an optional manifest field and two audit actions. `SandboxRouteErrorCode` gains a member.

A site that never turns the mode on behaves as before, except for two changes to the existing fence:

1. During a site-transfer import or media-usage activation, plugin media, comment, taxonomy and redirect writes are refused, as plugin content writes already are. During an export, they count as writes and restart it, as plugin content writes already do. A plugin should handle the refusal from these capabilities as it does for content writes. If the plugin leaves it unhandled, its route returns `503` with the code.
2. A running export no longer restarts when a plugin route or an allowlisted route is called. It restarts when site data changes, including through a plugin's guarded writes.

Older EmDash versions ignore the `emdash:read_only` row. Downgrading while frozen therefore unfreezes the site, so turn the mode off before downgrading.

## Security and privacy

- Only administrators change the mode, from a session or an `admin`-scoped API token. A token holding only `settings:manage` gets `403`. Session requests need `X-EmDash-Request`.
- The message is plain text written by an administrator, at most 500 characters, and the admin renders it as text. It never appears in API error bodies, so anonymous visitors can't read it.
- The manifest shows the message and start time to every signed-in admin user. The status endpoint, available to administrators only, adds who turned the mode on and who has entries open.
- Plugin routes keep their own authorization. Read-only mode removes no check from them; it only stops their writes to site data.
- Exempt routes keep sign-in working, so an administrator can always sign in and turn the mode off. If the fence query fails, the fence refuses the write.
- Enabling and disabling are audited. No public endpoint is added.

## Performance

- A fenced HTTP write still runs one fence query. The new scalar subquery reads one `options` row by primary key, so it adds no round trip.
- Each guarded plugin write reads the fence before writing, as plugin content writes already do. Plugin media, comment, taxonomy and redirect writes therefore gain one indexed read each. On a public comment submission, that read happens only when a plugin hook changes a comment's status through `ctx`. The read is what applies the import fence, the export restart and read-only mode to those writes, which skip all three today.
- Logged-out page renders never run the fence, so the query-count snapshot for logged-out routes doesn't change. Public comment submissions already read the fence and gain nothing.
- The manifest adds one key to an existing `getMany()` call. While the mode is on, each open admin tab fetches the manifest once a minute.
- The status endpoint runs one `options` read, one lease query joined to users, and one title query per collection with open entries. Only administrators call it.
- The scheduler reads the fence two or three times per tick, outside any request. While frozen, Node's scheduler ticks at most once a minute.

## Failure handling

- If the fence query fails, the write gets `503 TRANSFER_FENCE_CHECK_FAILED`, as today, and the client retries.
- If turning the mode on or off fails, the route returns an error and the state is unchanged. The state is a single row, so nothing is half-applied.
- Turning the mode on doesn't drain work already under way. Requests that passed the fence, the `after()` work they deferred and cron tasks already claimed can still write. Wait a minute after turning the mode on before taking a backup. Upload URLs issued before the freeze can still store objects. Their media rows stay pending, because confirming the upload is refused, and the system cleanup removes the rows and objects after the freeze ends.
- An administrator who can't load the admin can use the CLI or the REST API. As a last resort, `DELETE FROM options WHERE name = 'emdash:read_only'` turns the mode off.
- Operators can observe the mode through audit entries, one scheduler log line per change of state, and the admin banner.

## Verification

- Fence tests on SQLite and PostgreSQL (`describeEachDialect`): each source alone and combined, code precedence, both fallbacks, a malformed row, the scope flag, the allowlist and plugin-route scoping.
- One refused-write test per surface: content, media upload, comment submission, `execute` and `advance` for an import over REST and MCP (an `execute` refusal leaves the approval unused), each guarded plugin capability in-process and in the sandbox bridge (workerd tests), an MCP write tool, and both scheduler paths.
- Matching allowed tests: sign-in, a preview link, "Back up now", a site export, an MCP read tool, a plugin route that reads over `POST`, a plugin's KV and storage writes, and turning the mode off.
- A plugin request that makes several guarded writes is refused from the first write after read-only mode turns on or an import starts.
- An import refused partway by read-only mode reports `SITE_READ_ONLY` and resumes after the mode is turned off.
- Saving plugin settings and installing or enabling a plugin are refused.
- An export restarts when a guarded plugin capability writes during it, and doesn't restart when a plugin route reads or an allowlisted route is called.
- While frozen, Node's scheduler doesn't tick faster than once a minute, and a one-shot cron task keeps its retry count.
- REST: the permission and token-scope checks, validation, idempotent `PUT` and `DELETE`, and the open-entries list, including a lease on a deleted entry.
- The query-count snapshot is unchanged for logged-out routes.
- Admin browser tests: the banner, disabled editing, a freeze that starts mid-edit keeps the typed text, a freeze that ends while a tab is open, and the layout in Arabic.
- Manual check on Cloudflare: freeze a deployment, export a site package, import it into another deployment, and confirm the source refused writes throughout.

## Rollout and implementation

The feature ships in one minor release of `emdash`, `@emdash-cms/admin` and `@emdash-cms/cloudflare`, with changesets. It needs no feature flag, because the mode does nothing until an administrator turns it on.

1. Enforcement: the fence source and scope, the error code, the bridge statement, the plugin-capability guard, the import check, the scheduler checks and the fallbacks.
2. Controls: the REST route, the CLI subcommand, the audit actions and the manifest field.
3. Admin: the banner, the editor state, error messages, the settings switch with open entries, and the export hint.
4. Docs: a read-only mode guide, and a freeze step in the site transfer and backup guides.

[Appendix A](#appendix-a-implementation-reference) lists the files each step touches.

## Alternatives

- **Offline maintenance mode**, as in WordPress, Drupal, Craft, Laravel and Heroku. It takes the public site down, which a site move has to avoid, and it needs a check on every anonymous request.
- **An environment variable or integration option.** Changing it needs a deploy or host access, administrators can't change it from the admin, and a database backup doesn't carry it. It could be added later as a force-on override.
- **A site setting read through `getSiteSettings()`.** Its 30-second per-isolate cache lets writes through after the switch.
- **A database switch.** D1 has none. PostgreSQL's `default_transaction_read_only` and SQLite's `PRAGMA query_only` are per-session defaults that any client can change, and Turso's `block_writes` exists only on Turso. None of them returns a useful error or covers media storage.
- **Edge rules only.** Editors get no explanation, scheduled publishing and writes made on `GET` get through, and the rules depend on the host.
- **Fencing every plugin route by HTTP method.** Plugins read over `POST`: the forms plugin lists forms and serves its public form definition that way, and the admin loads Portable Text field options the same way. Blocking those requests would break plugin pages and embedded forms while the site is frozen.
- **Letting plugin routes declare themselves read-only.** It would need a new plugin API and an update to every plugin. The capability guard covers site data without either, and declarations can still be added later.
- **Exempting administrators,** as Discourse's staff-writes-only mode and Jira's system-administrator exemption do. An administrator's edits are lost in a move like anyone else's. Jira also documents that its permission-layer enforcement lets automation rules and mail handlers write.
- **Freezing only while an export runs.** Discourse [removed](https://meta.discourse.org/t/when-to-use-readonly-mode-during-backup/136009) its equivalent in 2020. A move needs the freeze until traffic switches, and the export already restarts when a write lands.
- **Locking or demoting users.** These are writes themselves, someone has to undo them, and tokens, plugins and the scheduler keep writing.

## Drawbacks

- Enforcement lives in the application. Code that writes outside EmDash's APIs isn't blocked, and neither are a plugin's own KV, storage and settings writes. In a raw database move, plugin data written after the backup is lost.
- Scheduled entries publish late and plugin cron runs late, once the mode ends. Cron tasks that only call external services wait too.
- A write that starts from a `GET` request can see a replica's stale state for as long as the replica lags.
- Sign-in, user and token changes still write. In a raw database move, such changes made after the backup are lost.
- Comment submissions during the freeze are refused, not queued.
- A forgotten freeze blocks editing until someone turns it off. The banner shows when it started.
- The fence gains a third source, a second scope flag and an allowlist, and the sandbox bridge keeps a second copy of the fence statement.

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

| Step        | Change                                                      | Files                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enforcement | Fence source, precedence, fallbacks                         | `packages/core/src/transfer/fence.ts`, `packages/cloudflare/src/sandbox/bridge.ts`                                                                                                                                                                    |
| Enforcement | Error code, status and retry handling                       | `packages/core/src/transfer/errors.ts`, `packages/core/src/plugins/sandbox/types.ts`, `packages/cloudflare/src/sandbox/wrapper.ts`, `packages/core/src/cli/site/shared.ts`                                                                            |
| Enforcement | Scope flag, allowlist, plugin-route scoping, exempt route   | `packages/core/src/astro/middleware/media-usage-write-fence.ts`                                                                                                                                                                                       |
| Enforcement | Import check                                                | `packages/core/src/api/handlers/transfer.ts` (`handleImportExecute()`), `packages/core/src/transfer/import/advance.ts` (`advanceImport()`)                                                                                                            |
| Enforcement | Plugin-capability guard, recorded after the write           | `packages/core/src/plugins/context.ts`, `packages/cloudflare/src/sandbox/bridge.ts` (which today records before writing), `packages/core/src/emdash-runtime.ts` (`createTaxonomyAccessWithWrite` wiring, plugin comment moderation)                   |
| Enforcement | Scheduler checks                                            | `packages/core/src/plugins/cron.ts`, `packages/core/src/emdash-runtime.ts` (`runScheduledMaintenanceTick`, `publishScheduledWithFence`, scheduler wiring)                                                                                             |
| Controls    | Route and handler                                           | `packages/core/src/astro/routes/api/admin/read-only.ts`, `packages/core/src/api/handlers/read-only.ts`                                                                                                                                                |
| Controls    | Audit actions                                               | `packages/core/src/database/repositories/audit.ts`                                                                                                                                                                                                    |
| Controls    | Manifest field                                              | `packages/core/src/astro/routes/api/manifest.ts`, `packages/core/src/astro/types.ts`                                                                                                                                                                  |
| Controls    | CLI                                                         | `packages/core/src/cli/commands/site.ts`                                                                                                                                                                                                              |
| Admin       | Banner, editor state, error messages, settings, export hint | `packages/admin/src/components/Shell.tsx`, `packages/admin/src/router.tsx`, `packages/admin/src/lib/api/client.ts`, `packages/admin/src/components/settings/GeneralSettings.tsx`, `packages/admin/src/components/settings/transfer/ExportSection.tsx` |
| Docs        | Guide and freeze steps                                      | `docs/src/content/docs/guides/`, `guides/site-transfer.mdx`, `guides/backups.mdx`, the REST API and CLI references                                                                                                                                    |
