---
title: Editorial comments
type: rfc
status: proposed
authors:
  - Matt Kane (@ascorbic)
champion: Matt Kane (@ascorbic)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4054
created: 2026-10-09
---

# Editorial comments

## Summary

Add editorial comments: threaded conversations that editors attach to an entry, a field, a Portable Text block, or a range of text while reviewing content, similar to comments in Google Docs or Notion. Threads are stored outside the content in two new system tables, so commenting never edits the entry, never takes the edit lock, and never reaches published output. The admin entry editor is the primary interface. The visual editing toolbar is a second, lighter client of the same API.

## Problem and user case

EmDash sites with more than one person working on content have no place to discuss a draft inside the CMS. A reviewer who wants a sentence reworded, a claim sourced, or an image replaced has to describe the location in an external channel ("third paragraph under the second heading"), and the feedback is disconnected from the content it refers to. Teams that move from Google Docs, Notion, or WordPress editorial plugins expect to select text and leave a comment on it.

These constraints make external workarounds harder in EmDash:

- Entry edit locks, on by default for each collection, allow one person to edit an entry at a time. Everyone else sees the entry read-only, so a reviewer cannot leave an inline note in the content even informally.
- Contributors hold `content:read_drafts` but neither `content:edit_own` nor `content:edit_any`, so they can read drafts they cannot change.
- Feedback about layout ("this headline wraps badly", "the crop cuts off the subject") only makes sense on the rendered page, and the visual editing toolbar has no way to record it.

EmDash already has public comments (`_emdash_comments`), which are visitor comments with moderation, Turnstile, and IP hashing. They have a different trust model and lifecycle and cannot serve this purpose.

## Example

An editor opens a draft post in the admin while its author holds the edit lock. The editor selects "the fastest CMS on the market" in the body, chooses **Comment** from the selection menu, and writes a request for a source that mentions the author.

The admin sends:

```http
POST /_emdash/api/content/posts/01JA8YQ7D3F2H6K9M4N8P1R5ST/threads
X-EmDash-Request: 1
Content-Type: application/json

{
	"version": 14,
	"anchor": {
		"type": "text",
		"field": "body",
		"blockKey": "k3f9a2",
		"start": 29,
		"end": 58,
		"quote": "the fastest CMS on the market",
		"prefix": "independent tests show it is ",
		"suffix": ", with sub-millisecond reads"
	},
	"body": "Do we have a source for this? <@01J9ZK4B7C2D8E5F1G6H3J0KMN> could you link the benchmark?"
}
```

The author's editor picks up the thread on its next poll and highlights the quoted text. The author adds a short sentence at the start of the paragraph, so the quoted text moves 12 characters later in the block. ProseMirror maps the highlight through the edit. After the author's next save, the admin reports the new offsets:

```http
PATCH /_emdash/api/content/posts/01JA8YQ7D3F2H6K9M4N8P1R5ST/threads/anchors
X-EmDash-Request: 1
Content-Type: application/json

{
	"version": 15,
	"anchors": [
		{
			"threadId": "01JA8Z6Q2W4V9R7T3M5K1N0PXC",
			"anchorState": "attached",
			"anchor": {
				"type": "text",
				"field": "body",
				"blockKey": "k3f9a2",
				"start": 41,
				"end": 70,
				"quote": "the fastest CMS on the market",
				"prefix": "independent tests show it is ",
				"suffix": ", with sub-millisecond reads"
			}
		}
	]
}
```

The author replies with a link and resolves the thread. The entry's content and revisions are unchanged by any of these steps.

## Goals

- Let users who can read an entry's drafts start and reply to threads on that entry without holding the edit lock or edit permission, and let the thread's creator, the entry's owner, or an editor resolve them.
- Anchor threads to an entry, a field, a Portable Text block, or a text range within one Portable Text block.
- Keep text and block anchors attached through edits made in the admin editor, and re-attach them by quoted text after edits made anywhere else.
- Show a thread whose anchor can no longer be found, together with the text it originally referred to, instead of discarding it.
- Notify mentioned users and thread participants by email when the site has an email provider.
- Expose field- and entry-level threads in the visual editing toolbar.
- Add no queries, HTML, or script to logged-out page renders.

## Non-goals

- Real-time co-editing, presence indicators, or live delivery of comments. Clients poll.
- Suggested edits or tracked changes.
- Public or anonymous commenting, including comments from preview-link visitors without an account.
- A cross-entry inbox, "assigned to me" views, or open-thread counts in the entry list.
- Blocking publication while threads are open.
- Notification preferences, digests, or in-app notifications.
- Plugin hooks for editorial comments.
- Anchors to nested field paths, to text spanning more than one block, or to arbitrary rendered DOM elements.
- Fuzzy re-attachment of text whose quoted characters were themselves changed outside an open editor.
- Including threads in site transfer exports.

## Detailed design

### Terms

A **thread** has one anchor, an open or resolved status, and an ordered list of **comments**. "Comment" in this RFC always means an editorial comment. The existing visitor feature is called public comments.

### Anchors

An anchor is a JSON object with a `type` discriminator:

```ts
type EditorialAnchor =
	| { type: "entry" }
	| { type: "field"; field: string }
	| { type: "block"; field: string; blockKey: string }
	| {
			type: "text";
			field: string;
			blockKey: string;
			start: number;
			end: number;
			quote: string;
			prefix: string;
			suffix: string;
	  };
```

- `field` is a top-level field slug of the entry's collection. The server validates it against `_emdash_fields` when the thread is created.
- `block` and `text` anchors require a `portableText` field. `blockKey` is the block's Portable Text `_key`.
- `start` and `end` are UTF-16 code unit offsets into the concatenated `text` of the block's spans, with `start < end`.
- `quote` is the exact selected text, 1 to 2,000 code units. `prefix` and `suffix` are up to 64 code units of surrounding text from the same block.

The `type` discriminator lets later work add anchor types, such as Yjs relative positions if co-editing is introduced, without changing existing rows.

### Shared anchor module

A pure module exported from `@emdash-cms/admin/editorial-anchors` creates and resolves anchors. Core already imports `@emdash-cms/admin/html-block`, and the admin cannot import from core, so both packages can use a module in this location. It provides:

- `createTextAnchor(fieldValue, field, blockKey, start, end)`, which derives `quote`, `prefix`, and `suffix` from a Portable Text value.
- `resolveAnchor(fieldValue, anchor)`, which returns `{ state: "attached", blockKey, start, end }` or `{ state: "orphaned" }`.
- Conversion between ProseMirror positions and block-relative offsets.

`resolveAnchor` resolves a text anchor in this order and stops at the first success:

1. The block with `blockKey`, if the text from `start` to `end` equals `quote`.
2. Occurrences of `quote` in that block.
3. Occurrences of `quote` in every text block of the field.

When a step finds several occurrences, it ranks them by the length of matching `prefix` and `suffix`, then by distance from the original `start`. A block anchor resolves when a block with `blockKey` exists in the field. Entry anchors always resolve. Field anchors resolve while the field exists in the collection schema.

### Data model

One migration (the next free number at implementation time) creates two tables. Timestamps are ISO 8601 UTC strings written by the handlers, matching `_emdash_entry_locks`.

`_emdash_editorial_threads`:

| Column         | Type | Notes                                                          |
| -------------- | ---- | -------------------------------------------------------------- |
| `id`           | text | Primary key, ULID                                              |
| `collection`   | text | Not null                                                       |
| `entry_id`     | text | Not null; the per-locale entry row ID                          |
| `anchor`       | text | Not null; JSON `EditorialAnchor`                               |
| `anchor_state` | text | Not null, default `'attached'`; `'attached'` or `'orphaned'`   |
| `status`       | text | Not null, default `'open'`; `'open'` or `'resolved'`           |
| `created_by`   | text | References `users.id`, `ON DELETE SET NULL`                    |
| `resolved_by`  | text | References `users.id`, `ON DELETE SET NULL`                    |
| `resolved_at`  | text | Null while open                                                |
| `created_at`   | text | Not null                                                       |
| `updated_at`   | text | Not null; advances on any change to the thread or its comments |

Indexes: `idx_editorial_threads_entry` on `(collection, entry_id, status)`, `idx_editorial_threads_created_by`, and `idx_editorial_threads_resolved_by`.

`_emdash_editorial_comments`:

| Column       | Type | Notes                                                                    |
| ------------ | ---- | ------------------------------------------------------------------------ |
| `id`         | text | Primary key, ULID                                                        |
| `thread_id`  | text | Not null; references `_emdash_editorial_threads.id`, `ON DELETE CASCADE` |
| `author_id`  | text | References `users.id`, `ON DELETE SET NULL`                              |
| `body`       | text | Not null; empty after deletion                                           |
| `created_at` | text | Not null                                                                 |
| `edited_at`  | text | Null until edited                                                        |
| `deleted_at` | text | Null until deleted                                                       |

Indexes: `idx_editorial_comments_thread` on `(thread_id, created_at)` and `idx_editorial_comments_author_id`.

Threads belong to an entry row, not a revision. Because each locale is a separate row, threads are per-locale. Publishing, unpublishing, scheduling, and restoring a revision do not touch threads. Restoring a revision changes the content, so text anchors re-attach on the next load.

### Comment bodies and mentions

A body is plain text of 1 to 10,000 characters. A mention is the token `<@USER_ID>`. Clients render each token as the user's current display name, so renames apply to old comments. On create and edit, the server extracts mention tokens and rejects the request with `VALIDATION_ERROR` if a mentioned user does not exist or does not hold `editorial:comment`.

### Permissions

Add two permissions to `packages/auth/src/rbac.ts`:

| Permission          | Minimum role | Grants                                                               |
| ------------------- | ------------ | -------------------------------------------------------------------- |
| `editorial:comment` | Contributor  | Read threads, start threads, reply, edit and delete own comments     |
| `editorial:manage`  | Editor       | Resolve and reopen any thread, delete any comment, delete any thread |

Every route also requires `content:read_drafts`, because threads discuss unpublished content. A user can resolve or reopen a thread when they hold `editorial:manage`, created the thread, or own the entry and hold `content:edit_own`. Only a comment's author can edit it. A thread can be deleted by a holder of `editorial:manage`, or by its creator while it has no comments from other users.

All routes live under `/_emdash/api/content/{collection}/{id}/`, so token requests fall under the existing scope rules in the auth middleware: `content:read` for `GET` and `content:write` for writes. No new token scopes are needed.

### API

Each route starts with `export const prerender = false`, validates bodies with `parseBody`, and verifies that the thread belongs to the collection and entry in the path. Handlers live in `packages/core/src/api/handlers/editorial-comments.ts`.

| Method and path                             | Purpose                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET …/threads?status=open\|resolved\|all`  | List threads with their comments; `{ items, nextCursor? }`, default 50, max 100          |
| `POST …/threads`                            | Create a thread and its first comment from `{ version, anchor, body }`                   |
| `PATCH …/threads/{threadId}`                | Set `{ status }`                                                                         |
| `DELETE …/threads/{threadId}`               | Delete a thread and its comments                                                         |
| `POST …/threads/{threadId}/comments`        | Reply with `{ body }`; a reply to a resolved thread reopens it                           |
| `PATCH …/threads/{threadId}/comments/{id}`  | Edit `{ body }`                                                                          |
| `DELETE …/threads/{threadId}/comments/{id}` | Clear the body and set `deleted_at`; deleting a thread's only comment deletes the thread |
| `PATCH …/threads/anchors`                   | Update `{ version, anchors: [{ threadId, anchor, anchorState }] }` in one request        |
| `GET …/threads/mentionable?q=`              | Up to 10 users holding `editorial:comment`: `id`, display name, avatar URL               |

`GET …/threads` returns threads and comments from one query. Deleted comments are returned with an empty body so clients can show a placeholder in thread order. Author fields resolve to `null` for deleted users.

`POST …/threads` and `PATCH …/threads/anchors` carry the entry's optimistic-concurrency `version`, which every content save advances, including draft saves. The server compares it with the entry's current version and returns `CONFLICT` on a mismatch, so a client cannot store anchors computed against stale content. On `CONFLICT`, the client reloads the entry and resolves the anchors again.

The mentionable endpoint is per entry so that a future collection-scoped permission model can limit it to users with access to that entry. It never returns email addresses.

Writes to threads on an entry in the trash return `CONFLICT`. Reads remain available.

### Entry lifecycle

- Moving an entry to the trash and restoring it leaves its threads in place.
- Permanently deleting an entry deletes its threads in the same transaction that deletes its public comments and revisions in `packages/core/src/api/handlers/content.ts`.
- Duplicating an entry or creating a translation does not copy threads.
- Deleting a user sets `created_by`, `resolved_by`, and `author_id` to null. Their comments stay and display as from a deleted user.
- Removing a field from the schema leaves its threads in place. Clients treat their anchors as orphaned.

### Admin interface

The entry editor header gets a **Comments** button showing the number of open threads. It switches the sidebar between the entry settings and the comment panel, in the same way a block panel replaces the sidebar today.

The comment panel lists open threads in document order: entry threads, then field threads in schema order, then block and text threads by block order and offset. Orphaned threads follow under a **Detached** heading that shows each thread's quoted text. A filter shows resolved threads. Each thread has a **Go to text** action that scrolls to the anchor and selects it, so the panel is a complete keyboard-accessible interface and highlights are never the only way to find a thread.

Threads are created from:

- the Portable Text selection menu, for a selection within one text block (the action is disabled with an explanatory tooltip when a selection spans blocks);
- the block menu, for non-text blocks;
- a comment control beside each field label; and
- a **Comment on entry** action in the panel.

The editor renders text and block anchors as ProseMirror decorations styled with Kumo semantic tokens. Decorations map through each transaction, so anchors follow edits while the editor is open. On load and after each fetch, the editor resolves every anchor with `resolveAnchor`. After a successful save, or when resolution changes an anchor or its state, the editor sends one `PATCH …/threads/anchors` request with the anchors whose stored value differs.

When another user holds the edit lock, the editor is read-only. Selection and the **Comment** action must still work in that state.

The admin fetches threads when the entry opens, refetches when the window regains focus, and polls every 30 seconds while the entry editor is open. Deep links use `/_emdash/admin/content/{collection}/{id}?thread={threadId}` and open the panel at that thread.

All strings go through Lingui. The panel and highlights use logical Tailwind classes and must be checked in Arabic.

### Visual editing toolbar

When edit mode is active, the toolbar script collects the distinct entries referenced by `data-emdash-ref` attributes on the page and fetches their open threads, with at most 4 requests in flight. It adds a badge to annotated elements whose entry or field has open threads. Each annotated element offers a **Comment** action that opens a popover with the element's threads, a reply box, a resolve control, and an **Open in admin** link to the deep link above. The toolbar creates only entry and field threads.

Text and block threads appear in the toolbar as a count on their field's badge. Creating text anchors from the inline editor is a later slice, because `InlinePortableTextEditor` currently assigns a new `_key` to every block on each save, which would orphan block anchors and leave text anchors dependent on quote matching. Preserving block keys in the inline editor is a bug fix that can land independently.

Toolbar strings use the existing toolbar labels mechanism that the admin writes for each browser.

### MCP tools

Add four MCP tools that call the same handlers and apply the same permission checks: `editorial_thread_list`, `editorial_thread_create`, `editorial_comment_create`, and `editorial_thread_resolve`. For text anchors, `editorial_thread_create` accepts `field` and `quote` with optional `prefix` and `suffix`. The server resolves them against the current draft with the shared anchor module and returns `VALIDATION_ERROR` when the quote is not found or matches more than one location with equal rank.

### Email notifications

When a comment is created, the server collects recipients: mentioned users and earlier participants in the thread (its creator and comment authors), excluding the comment's author, deleted users, and users who no longer hold `editorial:comment`. If `EmailPipeline.isAvailable()` returns true, it sends each recipient an email with the entry title, an escaped excerpt of the comment, and the admin deep link. Sending is deferred with `after()`. Without an email provider, no notification is sent and the comment is still created.

## Compatibility and migration

All changes are additive: two new tables, two new permissions, new routes, a new admin subpath export, and new MCP tools. No existing table, route, response shape, or content value changes. Content tables are not altered, so `SchemaRegistry` does not change.

The migration only creates tables and indexes, uses `ifNotExists`, and can restart after any statement. Older application code ignores the new tables during a rolling deploy. Rolling back the package leaves the tables unused. The migration's `down` drops both tables.

Custom role work, such as [Custom roles and collection-scoped permissions](https://github.com/emdash-cms/emdash/discussions/3717), would need to include the two new permissions.

Each implementation slice adds a changeset for `emdash` and `@emdash-cms/admin` describing the user-visible behavior and the new permissions.

## Security and privacy

- **Authorization.** Every route checks `content:read_drafts` and the relevant editorial permission, and verifies that the thread and comment IDs belong to the collection and entry in the path. Write routes require the `X-EmDash-Request` header through the existing auth middleware, including writes from the visual editing toolbar.
- **Untrusted input.** Comment bodies render as text in React and are escaped with `escapeHtml` in email. Email subjects strip CR and LF, following `packages/core/src/comments/notifications.ts`. Anchors are validated with Zod, including the discriminator, field existence, string lengths, and `start < end`. The server does not trust client-supplied offsets for anything except storage and display.
- **Disclosure.** Threads never appear in public HTML, the content API, the search index, or site transfer exports. The mentionable endpoint discloses display names and avatars of users holding `editorial:comment` to other commenters. Today only admins hold `users:read`, so contributors gain visibility of staff display names. Email addresses are never returned.
- **Retention.** Deleting a comment clears its body. Threads remain until deleted or until their entry is permanently deleted.

## Performance

- **Logged-out routes.** No change. Public renders run no new queries, the bootstrap script is unchanged, and nothing is added to cached HTML. The query-count snapshots for logged-out routes must not change.
- **Admin entry editor.** One request when the entry opens, returning threads and comments from a single query, plus one request per poll every 30 seconds while the editor is open. Anchor updates add one request after a save only when an anchor changed.
- **Content saves.** No additional server work. Anchor updates are a separate request.
- **Permanent deletion.** One additional `DELETE` statement in the existing transaction.
- **Edit mode pages.** One request per distinct entry on the page, at most 4 concurrently. A single-entry page makes one request. A listing page with 20 entries makes 20.
- **Storage.** Two small tables indexed by entry.

## Failure handling

- **Anchor update fails or conflicts.** The stored anchor stays at its previous value. The next client to load the entry resolves it again from the quoted text and retries the update with the current version.
- **Quoted text removed outside an open editor.** The thread becomes orphaned and is listed under **Detached** with its original quote. If the text reappears, for example after a revision restore, the next resolution re-attaches it.
- **Email failure.** The handler logs the error with an `[editorial]` prefix. Notifications are not retried and do not affect the comment.
- **Polling failure.** The panel keeps the last successful data and shows that it could not refresh.
- **Concurrent changes.** Status changes are last-write-wins. Replying to a resolved thread reopens it.
- **Entry deleted while open.** Thread requests return `NOT_FOUND` and the panel shows an error.

## Verification

- **Unit tests** for `@emdash-cms/admin/editorial-anchors`: unchanged position, text inserted before the anchor, block moved, block key changed with the quote intact, quote deleted, duplicate quotes ranked by context and distance, surrogate pairs and combining characters, right-to-left text, and ProseMirror position conversion including hard breaks.
- **Integration tests** with `describeEachDialect`: thread and comment CRUD; the permission matrix for each role; resolution by creator, entry owner, and editor; mention validation; IDOR attempts using a thread from another entry; `CONFLICT` on stale `version`; writes to trashed entries; cascade on permanent deletion; null authors after user deletion.
- **Query counts:** `pnpm query-counts` shows no change for logged-out routes.
- **Playwright:** create a text comment, edit text before it, save, reload, and confirm the highlight covers the same text; comment as a second user while the first holds the lock; resolve and reopen; follow a deep link; repeat the panel checks in Arabic.
- **Visual editing:** confirm the badge and popover in edit mode, and confirm that logged-out HTML is byte-identical to the current output.
- **Email:** with an email provider configured, confirm recipients for mentions and replies and that the author is excluded. With none, confirm the comment is created and nothing is sent.

## Rollout and implementation

Each slice is usable on its own and ships without a feature flag:

1. Migration, handlers, routes, and permissions. Entry and field threads in the admin comment panel, with polling and deep links.
2. Text and block anchors in the admin Portable Text editor: the shared anchor module, decorations, resolution, and anchor updates.
3. Mentions, the mentionable endpoint, and email notifications.
4. Visual editing toolbar: badges, the popover, and entry and field threads.
5. MCP tools.
6. Text anchors in the inline editor, after `InlinePortableTextEditor` preserves block keys.

## Alternatives

- **Portable Text annotations.** Storing each thread as a `markDef` in the content would let ProseMirror and copy-paste move anchors automatically. It would also make commenting an edit: it would need the edit lock and edit permission, create a draft revision for every comment and resolution, and put comment marks into published Portable Text, API responses, MCP output, and exports unless every path stripped them. `mark-safety.ts` would have to allow the new mark.
- **Document-wide ProseMirror positions.** A single integer position has no stable identity and breaks on any edit made outside an open editor.
- **Yjs relative positions.** These need a Yjs document as the source of truth. EmDash stores Portable Text and does not implement co-editing. The anchor discriminator leaves room to add them later.
- **DOM or coordinate pins on the rendered page.** Pins break when templates change, cannot be shown in the admin, and do not identify content that a template renders in several places.
- **Reusing `_emdash_comments`.** Public comments carry visitor identity, IP hashes, moderation status, and plugin hooks, and they are included in site transfer. Sharing the table would risk editorial comments appearing in public queries and would fire public comment hooks.

## Drawbacks

- Anchors detach when the quoted text itself changes outside an open admin editor, through the API, MCP, the inline editor, or a revision restore.
- The admin and the visual editing toolbar are two clients to maintain, and the toolbar version has fewer features.
- Comments arrive up to 30 seconds late, and there is no presence information.
- Without notification preferences, active threads can generate a lot of email.
- Contributors can see the display names of everyone who can comment.
- The entry editor gains another sidebar mode.

## Open questions

- **Name.** "Editorial comments" keeps the familiar word but sits next to public comments in the admin navigation and documentation. "Notes" avoids the clash but is less familiar. The name determines the table names, permission names, and MCP tool names, so it must be settled before acceptance.
- **Per-collection setting.** Should collections have an `editorial_comments` setting like `edit_locking`, or is the feature always available?
- **Notification preferences.** Is a per-user opt-out required before email notifications ship?
- **Batched toolbar fetch.** Should the toolbar get a batch endpoint for listing pages? A sibling route under `content/{collection}/` would share a path segment with entry IDs.
- **Site transfer.** Site transfer maps user IDs to principals, so threads could be exported. Should they be?
