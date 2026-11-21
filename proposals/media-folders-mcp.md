---
title: Media Library folder management through MCP
type: rfc
status: proposed
authors:
  - Ondřej Varga (@onvarga)
champion: Ondřej Varga (@onvarga)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4936
created: 2026-11-16
---

# Media Library folder management through MCP

## Summary

Expose existing flat Media Library folders through five core Model Context Protocol (MCP) tools: `media_folder_list`, `media_folder_get`, `media_folder_create`, `media_folder_update`, and `media_folder_delete`. Add an optional `folderId` to `media_list` and `media_update` so clients can browse and organize existing media.

The tools use the existing folder handlers, validation, and permissions. Deleting a folder returns its media to the Main library and preserves the files and their references.

This is a proposed design, introduced in [Ideas Discussion #4936](https://github.com/emdash-cms/emdash/discussions/4936). A Maintainer sponsor remains to be identified before acceptance.

## Problem and user case

An EmDash site managed through the official MCP endpoint needs to group article images in Media Library folders. The admin and REST API support this workflow, but the MCP client cannot discover or manage the folders, filter media by folder, or change an item's folder.

A read-only inspection on 16 November 2026 found no folder tools in the site's complete `tools/list` response. The schemas for `media_list`, `media_update`, and `media_upload` had no `folderId`. The same gap exists in [upstream server registration at commit 8852f3f](https://github.com/emdash-cms/emdash/blob/8852f3faf825b9a43595f73aedf951fae4f22d1f/packages/core/src/mcp/server.ts). [PR #2584](https://github.com/emdash-cms/emdash/pull/2584) explicitly excluded MCP from the original folder foundation.

The [folder handlers](https://github.com/emdash-cms/emdash/blob/8852f3faf825b9a43595f73aedf951fae4f22d1f/packages/core/src/api/handlers/media-folders.ts) already implement listing, lookup, creation, renaming, and deletion. This proposal exposes that behavior through MCP.

## Example

After this proposal is implemented, a client can create an Article images folder with the following tool name and arguments.

```json
{
	"name": "media_folder_create",
	"arguments": { "name": "Article images" }
}
```

The successful result contains `item.id` and `item.name`. The client passes that returned ID to `media_update` as `folderId`, together with the ID of an existing media item. It then calls `media_list` with that folder ID to verify the assignment. The media ID, storage key, and URL stay unchanged.

To return the item to the Main library, the client sends `folderId: null` to `media_update`. Omitting `folderId` leaves its location unchanged.

## Goals

- Discover and manage the same shared flat folders available in the admin.
- Browse all media, the Main library, or one folder.
- Move existing media within the caller's current permissions.
- Preserve existing files, references, and API defaults.

## Non-goals

Nested folders, bulk moves, external-provider folders, CLI commands, and upload-to-folder behavior are outside this proposal. In particular, `media_upload` keeps its existing content-hash deduplication behavior. A later upload proposal must specify what happens when identical bytes already belong to another folder.

## Detailed design

The proposed tools return the existing handler payload through the standard MCP result wrapper.

| Tool                  | Arguments                       | Successful payload                       |
| --------------------- | ------------------------------- | ---------------------------------------- |
| `media_folder_list`   | Optional `limit`, `cursor`, `q` | `{ items: [{ id, name }], nextCursor? }` |
| `media_folder_get`    | `id`                            | `{ item: { id, name } }`                 |
| `media_folder_create` | `name`                          | `{ item: { id, name } }`                 |
| `media_folder_update` | `id`, `name`                    | `{ item: { id, name } }`                 |
| `media_folder_delete` | `id`                            | `{ deleted: true }`                      |

Reuse the existing folder input schemas and handlers. Folder IDs are strings of 1–64 characters. Names must contain 1–200 characters after trimming; the repository stores the trimmed name and enforces uniqueness using its existing NFKC and lowercase name key.

Folder listing defaults to 50 items, accepts an integer limit of 1–100, and returns a continuation cursor when needed. Search uses the existing normalized substring matching. Preserve the existing query and cursor validation, ordering, and escaping.

The two existing tools gain the following optional argument.

| Tool           | `folderId` value      | Meaning                                   |
| -------------- | --------------------- | ----------------------------------------- |
| `media_list`   | Omitted               | All media, preserving the current default |
| `media_list`   | `"unfiled"`           | Only Main library media                   |
| `media_list`   | Folder ID             | Only media in that folder                 |
| `media_update` | Omitted               | Preserve the current assignment           |
| `media_update` | `null` or `"unfiled"` | Return to the Main library                |
| `media_update` | Folder ID             | Assign the item to that folder            |

Normalize `"unfiled"` to `null` at the MCP boundary. Listing does not accept `null`, matching the REST query contract. A correctly shaped but missing folder ID produces an empty media list; assignment to a missing folder returns `NOT_FOUND`.

Use the existing runtime media methods for listing and updates, including their cache behavior. Register the folder handlers through the normal MCP registration wrapper so site-import write fencing and write accounting apply to folder mutations.

Set `readOnlyHint: true` on folder list/get. Set `readOnlyHint: false` on the three mutations, `destructiveHint: false` on create/update, and `destructiveHint: true` on delete. The delete description must state that it removes the folder and clears assignments while preserving media files. Do not advertise create as idempotent.

## Compatibility and migration

The interface is additive. Existing calls retain their defaults and result shapes. The existing `media_folders` table and `media.folder_id` relationship provide storage; no database migration is required.

Folders remain flat and shared. Removing a folder clears its assignments through the existing foreign-key behavior. Media IDs, storage keys, URLs, content references, and usage records remain intact.

Rollback removes the additional MCP interface while existing folders and assignments remain accessible in the admin and REST API. Clients discover support through `tools/list`; clients with tool allowlists need to enable the desired names and refresh their catalog after upgrade.

## Security and privacy

Folder list/get require `media:read` and the existing media-read permission. Folder create/update/delete require `media:write` and `media:edit_any`, currently Editor or Admin. Folders have no per-user ownership.

Adding `folderId` to `media_update` preserves its scope, role, and ownership checks: Authors may move their own media; Editors may move any local media. A write scope alone does not grant the user's role additional permissions.

Folder names and search strings remain untrusted input. Reuse parameterized queries and existing validation. Return folder IDs and names, not additional media details. MCP exposes no new external-provider access or credential fields. Tool annotations describe effects; authorization stays enforced on the server.

## Performance

Each operation uses the existing folder or media query path and bounded pagination. Registering five tools increases the MCP catalog and schema construction work. Measure catalog size and representative initialization, list, and mutation requests during implementation; this proposal claims no measured performance improvement.

The change adds no queries to logged-out page rendering and moves no storage objects.

## Failure handling

Preserve the standard MCP error wrapper and handler error codes. Missing records return `NOT_FOUND`; invalid names and cursors retain their existing validation errors; normalized name collisions return `CONFLICT`. Unexpected database errors retain the operation-specific `MEDIA_FOLDER_*_ERROR` codes without exposing database details.

A multi-step create-and-move workflow is not atomic. If a move fails, retain the created folder and report the failed item. Clients reconcile an uncertain write by reading the relevant folder or media item before retrying. A repeated create can conflict, and a repeated delete can return `NOT_FOUND`.

Retain current concurrent-update behavior; this proposal adds no revisions or compare-and-swap semantics. If a folder disappears before assignment, the assignment fails rather than storing a dangling reference.

## Verification

Exercise the proposed behavior through the MCP transport and a real isolated database:

- Create, list, get, rename, and delete a folder; follow paginated and searched results.
- Reject invalid names and IDs; preserve normalized duplicate-name and invalid-cursor errors.
- Distinguish all media, Main library media, and a named folder.
- Preserve assignment when `folderId` is omitted; clear it with `null` or `"unfiled"`.
- Deny insufficient scopes and roles; permit Author moves only for owned media.
- Reject assignment to a missing folder and cover deletion racing with assignment.
- Delete a populated folder and verify intact media records, bytes, URLs, references, and usage records.
- Verify import write fencing and standard MCP error serialization.
- Run unchanged legacy media calls to protect backwards compatibility.

Use the existing dialect test infrastructure for SQLite, PostgreSQL, and applicable D1/workerd checks. A manual admin check must show folder changes made through MCP after refresh. Validation in this design phase consists of source and live-schema inspection; these implementation tests have not been run.

## Rollout and implementation

After design acceptance, implement registration and argument forwarding with focused regression tests, update the MCP reference, and add the package changeset required for the additive API release. Existing folder schemas, handlers, and repositories remain the behavior owners.

No feature flag is proposed. Verify the released tool catalog and complete one folder lifecycle on a disposable site before enabling write tools in a production client's allowlist.

## Alternatives

The admin and REST API already support the workflow, but require an MCP client to switch interfaces. A site-specific plugin could expose equivalent tools, at the cost of duplicating a core interface and its authorization contract. Core MCP registration provides one documented interface for the existing feature.

A single tool with an `action` argument would mix read and write operations under one tool name and annotation. Separate tools allow clients to enable folder reads independently of folder mutations.

## Drawbacks

Five additional tools increase catalog size and maintenance work. MCP and REST must keep validation, permissions, and errors aligned. Clients still need separate calls for folder creation and media assignment.

## Open questions

- Identify a Maintainer sponsor.
- Confirm the proposed public tool names and argument semantics before acceptance.
