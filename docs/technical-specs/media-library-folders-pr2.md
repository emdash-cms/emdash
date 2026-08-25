# Strapi-style flat media folders in the admin

Status: Proposed
Dependency: Draft PR [#2584](https://github.com/emdash-cms/emdash/pull/2584) at `feat/media-folders-api` commit `b5b28210`, stacked on pagination PR [#2582](https://github.com/emdash-cms/emdash/pull/2582) at `5e0df073`
Intended position: PR 2 of the media-folders sequence; target `feat/media-folders-api`, then retarget to `main` after its dependencies merge
Reference implementation: Strapi Upload `5.49.0`, stable Media Library on Strapi `develop` commit `e8b156d3`; exclude the `future/` implementation behind `unstableMediaLibrary`

## Approval and authority

GitHub has no folder-specific maintainer-approved Discussion. Discussion [#990](https://github.com/emdash-cms/emdash/discussions/990) is a broad media-workflow roadmap whose maintainer feedback asks for separate discussions before implementation. Discussion [#1655](https://github.com/emdash-cms/emdash/discussions/1655) covers media usage, not folders.

The design may be approved in this thread, but implementation and a ready-for-review feature PR remain blocked until maintainers confirm that one of those Discussions covers folders or approve a folder-specific breakout Discussion.

This specification authorizes only its own creation and revision. It does not authorize source changes, commits, pushes, PR2 creation, or GitHub mutations. Use `$feat-implement` after the product decisions and Discussion gate are approved.

## Summary

Add flat-folder browsing and management to the main local Media Library. Reproduce Strapi's stable folder workflow where PR1's flat model supports it:

- a Back action and breadcrumbs inside a folder;
- a secondary **Add new folder** action beside the primary upload action at the root;
- folders before separately paginated media on page 1;
- folder cards in grid view and folder rows before media in list view;
- a labeled pencil action that opens the shared create/edit dialog;
- folder deletion from that dialog; and
- a **Location** field in Media Details for moving one local media item.

PR2 does not pretend PR1 is hierarchical. It removes Strapi's parent selector, ancestor menu, child counts, bulk selection, bulk move, drag-to-folder, and recursive delete. Uploads continue to enter the Main library until duplicate-upload placement has an approved product rule.

## User outcome

An editor can create a folder, open it, move one existing media item into or out of it, rename it, and delete it without deleting any media. Readers can browse folders. Browser Back and direct folder URLs recover reliably. Existing providers and media pickers continue to see all media and do not gain folder controls.

## Goals

- Make PR1's flat folders usable from the main local Media Library.
- Match the stable Strapi placement, labels, navigation, dialog actions, and folder-first result ordering where the flat model permits.
- Preserve numbered pagination's stable grid, scroll, focus, page recovery, and 35/70/90 page sizes.
- Keep folder work authenticated, bounded, localized, RTL-safe, keyboard accessible, and provider-local.
- Keep media IDs, storage keys, URLs, usage records, and content references unchanged.
- Add only the smallest server reads needed for reliable direct folder URLs and bounded global folder search.

## Non-goals

- No nested folders, parent IDs, paths, ancestor menus, or folder-to-folder moves.
- No folder child counts, per-folder media counts, or count queries.
- No bulk selection, bulk move, bulk delete, mixed folder/media actions, or drag-to-folder.
- No upload-to-current-folder, upload dialog Location field, or direct/signed upload contract changes.
- No folder controls in `MediaPickerModal`, content fields, Portable Text, providers, CLI, MCP, plugins, or imports.
- No All-media sidebar, folder tree, or general navigation framework.
- No change to media deletion, replacement, usage, search indexes, storage objects, or deduplication.
- No adoption of Strapi's experimental `future/` Media Library.
- No rewrite of the existing asset grid, numbered paginator, provider tabs, upload queue, or detail-dialog layout.

## Verified current behavior

### PR1 contracts

PR1 provides:

- flat globally unique folders;
- `media.folder_id` with `ON DELETE SET NULL`;
- folder list/create/update/delete routes;
- media list filtering where omitted `folderId` means All media, `unfiled` means Main library, and an ID means one folder;
- single-media assignment through `PUT /_emdash/api/media/:id`;
- editor-only folder management and ownership-aware media assignment; and
- typed core-client support.

Deleting a folder preserves media identity and returns its media to the Main library. Uploads create media with `folderId: null`.

### EmDash admin

`MediaPage` in `packages/admin/src/router.tsx` owns local filename search, MIME filter, numbered page, page size, retained total, empty-page recovery, upload mutation, and the `['media', ...]` query. `keepPreviousData` and `MediaLibrary`'s inert pending state prevent layout jumps.

`MediaLibrary` owns provider selection, search input, type selector, grid/list view, upload dialog, detail dialog, focus restoration, and Kumo pagination. Folder UI must be local-only and must not change provider queries.

`MediaDetailPanel` already combines local image metadata in one update mutation, surfaces mutation errors with `DialogError`, confirms destructive actions with `ConfirmDialog`, and closes with focus recovery. Folder assignment belongs in this update, not in a second detail dialog.

The admin media client lacks folder types and functions. It already supplies the CSRF header, envelope parsing, and server-message propagation through `apiFetch`, `parseApiResponse`, and `throwResponseError`.

### Stable Strapi behavior to reproduce

Stable Strapi uses `folder` in URL state, fetches the current folder separately, shows Back and breadcrumbs inside a folder, renders folders before assets only on asset page 1, and resets selection when the folder changes.

Its grid shows four, three, two, then one folder card across breakpoints. Folder cards show a folder icon, linked name, and labeled pencil edit action revealed on hover or focus. List view puts folder rows before asset rows and provides explicit keyboard-accessible open/edit controls.

The header places secondary **Add new folder** and primary **Add new assets** actions together. Create/edit uses one dialog with **Cancel**, **Create** or **Save**, and **Delete folder** while editing. Asset editing includes a **Location** selector.

Strapi search is library-wide: when a search term exists, asset and folder queries ignore the current folder. Folder links clear search. MIME filtering suppresses folders. Successful folder creation returns the asset paginator to page 1.

## Deliberate differences from Strapi

These are product boundaries, not incomplete implementation:

| Strapi stable behavior                                | EmDash PR2 behavior                         | Reason                                                     |
| ----------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Nested folders and Location tree                      | One flat root and one folder level          | PR1 is flat by design                                      |
| Child-folder and asset counts                         | No subtitle counts                          | PR1 intentionally adds no folder counts; avoid N+1 queries |
| All folders fetched unbounded                         | 100 per request with **Load more folders**  | EmDash list work stays bounded                             |
| Recursive destructive folder delete                   | Media returns to Main library               | Preserve content references and stored files               |
| Upload into current folder                            | Upload is available only at the root        | Duplicate-upload placement remains undecided               |
| Bulk move and folder drag/drop                        | One media item moves through Media Details  | PR1 exposes only single-media assignment                   |
| Physical left/right styling and unmirrored Back arrow | Logical spacing and mirrored direction icon | EmDash supports RTL                                        |

## Information architecture and visual contract

The root is the Main library, matching Strapi's unfiled root. An absent `folder` URL parameter maps to API `folderId: null`. `?folder=<id>` opens one flat folder. PR2 does not expose the API's compatibility-oriented All media view in the admin.

```text
Root

Media Library                                  [Add new folder] [Upload Files]
[Search by filename...] [All types]                         [Grid] [List]

Folders
[ Folder icon  Product photos        Edit ]
[ Folder icon  Press                  Edit ]
[ Load more folders ]
------------------------------------------------------------
[ existing media grid or table ]
[ existing numbered pagination ]

Folder

< Back
Media Library / Product photos
[Search by filename...] [All types]                         [Grid] [List]

[ media assigned to Product photos ]
[ existing numbered pagination ]
```

### Header

- Root: current Media Library title, secondary **Add new folder**, primary **Upload Files**.
- Folder: **Back**, Kumo `Breadcrumbs` with linked **Media Library** and current folder text, no create-folder or upload action.
- On narrow screens, actions become full-width and stack below the title. Back stays before the title in reading order.
- Folder management actions render only for editor-level users. Folder browsing renders for every existing Media page reader.

### Folder grid and list

- Render folders only for the local provider, asset page 1, and no MIME filter. Outside the root, render them only while a filename search is active, matching Strapi's library-wide search result mode.
- Send the filename term to the bounded folder list API and make asset search library-wide, matching Strapi. A visible **Load more folders** remains when later matching folder pages exist.
- Grid order: localized **Folders** heading, 4/3/2/1 folder columns, divider when media also exists, then the unchanged asset grid.
- List order: folder rows before asset rows. Folder rows contain icon, linked name, and labeled edit action; MIME, size, and date cells use an em dash and accessible context rather than fake values.
- Do not display a numeric folder total because the API does not return one.

Use Kumo `LayerCard`, `Button`, `Link` or router composition, `Breadcrumbs`, `Dialog`, `Input`, `Combobox`, `Loader`, and Toast APIs. One folder card exposes one navigation link and one edit button; do not nest interactive controls. The edit button stays reachable on touch and keyboard, even if its visual emphasis is reduced until hover/focus on pointer devices.

## URL and navigation state

Add `folder?: string` to the TanStack media route search schema.

- Absence means Main library.
- A non-empty string of at most 64 characters means one folder ID.
- Folder-card navigation pushes history, clears the filename search, resets page to 1, clears retained totals, closes Media Details, and preserves page size, type filter, view mode, and provider state.
- Back pushes the root state, preserves the current search and type filter like stable Strapi, and resets page to 1.
- A stale or deleted folder replaces the URL with root and shows one localized informational toast. It must not add a broken history entry or retry forever.
- Folder navigation must not scroll the document to the top. Existing item/paginator focus preservation remains; when the triggering folder or media disappears, focus falls back to the Media Library heading with `preventScroll` where supported.

Search remains component state in PR2. Browser history restores folder selection but does not attempt to reconstruct an earlier search term. Moving all Media page query state into the URL is out of scope.

## Minimal server additions

Add authenticated `GET /_emdash/api/media/folders/:id` using the existing repository `findById`.

- Permission: `media:read`; bearer scope remains `media:read` through the existing media-prefix rule.
- Response: `{ item: MediaFolder }`.
- Unknown or invalid ID: `NOT_FOUND` or `VALIDATION_ERROR` through existing schemas/status mapping.
- Add the GET operation to OpenAPI and the typed core client.
- No migration, runtime method, new permission, new token scope, count, or new repository query is required.

This separate current-folder read matches stable Strapi, makes direct URLs reliable, and avoids fetching every folder page merely to resolve one name.

Add optional `q` to `GET /_emdash/api/media/folders`.

- Trim and cap it at 200 UTF-16 code units, matching media filename search.
- Normalize it with the same NFKC-plus-lowercase rule as `name_key` and escape SQL `LIKE` wildcards.
- Match a substring of `name_key` before cursor pagination.
- Preserve the existing 1–100 limit, `name_key ASC, id ASC` cursor order, and omitted-query behavior.
- Add the query to schemas, OpenAPI, typed clients, and SQLite/PostgreSQL repository tests.

This is the smallest way to reproduce Strapi's library-wide folder search without automatically draining every folder cursor or returning incomplete client-filtered results.

## Admin data flow

### Admin client contracts

Keep the shared admin `MediaItem` compatible with provider and external-URL picker items. Add a `LocalMediaItem extends MediaItem` subtype with required `folderId: string | null`, `authorId: string | null`, and local storage fields. Local media list/get/upload/update calls return `LocalMediaItem`; provider conversion and picker-created external items remain `MediaItem` and do not gain fake local fields.

Add `MediaFolder`, its cursor-list response, `folderId?: string | null` on local `fetchMediaList`, and `folderId?: string | null` on the existing media update input. Type the main local Media page and its detail path with `LocalMediaItem`, while shared picker/provider component boundaries retain the wider `MediaItem` type.

Add admin functions for bounded folder list/search, current-folder get, create, rename, and delete. Encode every path ID with `encodeURIComponent`, use `apiFetch`, and parse the normal `{ success, data }` envelope.

Add an `ApiResponseError extends Error` in the shared admin client with additive `status`, `code`, and `details` fields. `throwResponseError` keeps its current localized message behavior but throws this subtype. Existing callers remain compatible because it is still an `Error`; the folder dialog uses `VALIDATION_ERROR` and `CONFLICT` to place field errors under Name and sends unclassified failures to `DialogError`.

### Folder queries

Use two query families:

- `['media-folders', 'page', { search }]`: Media page `useInfiniteQuery`, `limit: 100`, optional normalized `q`, and cursor from `nextCursor`; flatten only fetched pages.
- `['media-folders', 'location', { search }]`: independent Location `useInfiniteQuery` with the same request contract but its own pages.
- `['media-folder', folderId]`: one-folder GET, enabled for a named route folder or a selected local media item's non-null folder.

Enable the page folder-list query only at the root or while filename search is active, and only when the local provider and asset page 1 are active with no MIME filter. A named folder with no search does not fetch the 100-row folder list. The folder grid calls the list query with the Media page's debounced filename search.

The Location Combobox owns a separate debounced `locationSearch` and enables its folder-list query only after the Combobox opens for a movable local item. It starts with an empty term. Opening Media Details may fetch only the selected item's one current folder so the closed control has an accurate label; it must not fetch the 100-row Location list until the user opens the control. A Media page search must never restrict the locations offered in Media Details.

Folder-grid and Location-combobox **Load more folders** actions fetch one bounded page at a time from their separate query keys. Identical search strings must not share pages between the two surfaces. Folder mutations invalidate the shared `['media-folders']` prefix. Do not automatically drain every cursor.

If a selected media item's current folder is not in the loaded Location list, fetch that item's folder through the same `['media-folder', id]` query family and inject it into the Combobox options without duplicating it. The route folder and selected item's folder may be different during library-wide search.

### Media query

Extend the existing key to:

```ts
["media", { search, mime: mimeKey, folder: folderId ?? "main", page, perPage }];
```

The media request uses:

- `folderId: null` at the root;
- the current folder ID inside a folder; and
- omitted `folderId` while filename search is non-empty, reproducing Strapi's library-wide search.

Search takes precedence over folder scope exactly as in stable Strapi. With search plus MIME, both filters apply library-wide and folders stay hidden. With MIME and no search, media remains folder-scoped and folders stay hidden. Folder or filter changes reset the asset page and retained total before the next query. Keep `placeholderData: keepPreviousData`, page recovery, inert loading content, pagination focus, and stable layout.

### Mutations and invalidation

| Action        | Request                                   | Success behavior                                                                                                              |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Create folder | `POST /media/folders`                     | Invalidate `['media-folders']`, go to page 1, toast success, close, restore trigger focus                                     |
| Rename folder | `PUT /media/folders/:id`                  | Invalidate folder list and current folder, update breadcrumb/card, toast success, close, restore edit focus                   |
| Delete folder | `DELETE /media/folders/:id`               | Invalidate folders, media, and `['media-folder', deletedId]`; if current, replace URL with root; toast success; focus heading |
| Move media    | existing `PUT /media/:id` with `folderId` | Invalidate media; close detail; focus original card or heading if it left the result set                                      |

Do not optimistically remove folder or media rows. Server foreign keys and permission checks determine the committed state; invalidation reads it back.

## Folder create/edit dialog

Use one focused `MediaFolderDialog` for create and edit.

Create:

- title **Add new folder**;
- one **Name** input, autofocus on open;
- **Cancel** and **Create**;
- Enter submits from the Name input.

Edit:

- title **Edit folder**;
- prefilled **Name** input;
- **Cancel**, destructive-light **Delete folder**, and primary **Save**;
- no Location, creation date, child count, or asset count.

Behavior:

- Trim and validate 1–200 UTF-16 code units before mutation, while the repository remains authoritative.
- Duplicate and validation messages render inline through the Kumo `Input` error surface. Unexpected server errors use `DialogError`.
- Keep the dialog open on error. Disable close-by-submit and all conflicting actions while pending. Ignore duplicate submit attempts.
- Success closes, toasts, and restores focus.
- Delete opens the existing `ConfirmDialog` with explicit localized copy: **Delete “{name}”? Media in this folder will return to Main library. No files will be deleted.**
- Canceling delete leaves the edit dialog open and restores focus to **Delete folder**.

## Media Details Location field

Add a local-only Kumo `Combobox` labeled **Location** for every local MIME type.

Options are synthetic **Main library** (`null`) followed by loaded folders in name order. The dropdown contains **Load more folders** while a cursor remains. The current folder fetched by ID is present even if its list page has not loaded.

Permission:

- editors can move any local media;
- authors can move media whose `authorId` matches the current user;
- other users see the current location as read-only text;
- provider items receive no folder field or requests.

Folder and image metadata changes submit in one existing `updateMedia` call. A folder-only change works for images, videos, audio, and documents. The dirty-state and discard confirmation include Location. The server preserves atomicity when a folder disappears during save; the dialog shows the server error and remains open.

## Upload behavior

At the Main library root, uploads and whole-page file drop behave exactly as they do now. New and deduplicated media retain the PR1 upload behavior.

Inside a folder on the local Library tab:

- hide **Upload Files** and disable the page-level drop overlay;
- the empty state says **This folder is empty** and explains that media can be moved here from Media Details;
- provide **Back to Main library**, not an upload action.

Do not upload then issue a second assignment request. That fails badly when a duplicate upload returns an asset already assigned elsewhere and creates a retry state where the bytes succeeded but placement failed.

External-provider upload controls remain unchanged even when the URL retains a local folder selection.

## Loading, empty, error, and race states

- Initial root load: render the existing Media Library shell; folder section gets an inline loader while media can render independently.
- Folder-list error: keep media usable, show a localized inline folder error with **Retry**.
- Current-folder load: breadcrumb current item uses Kumo loading state; retain the prior media shape until the folder read resolves.
- Missing/deleted direct folder: replace to root once and toast.
- Root with folders but no media: show folders and no whole-library empty state.
- Root with neither: retain the existing upload empty state.
- Named folder with no results and no active search/filter: folder-empty state and Back action.
- Search/type no results: retain **No matching media** and clear controls.
- Delete races with move: server returns `NOT_FOUND`; keep the detail dialog open and refetch folder/media state.
- If the selected item's one-folder read returns `NOT_FOUND`, fetch that media item by ID and replace `MediaLibrary`'s open `detailItem` through an explicit `onItemRefreshed(LocalMediaItem)` callback. Also invalidate the media-list prefix. Keep Location in a loading state until the refreshed item arrives; its `folderId: null` disables the deleted-folder query and renders **Main library** without treating the whole dialog as failed. Refetching only the list cache is insufficient because the current component stores `detailItem` independently.
- Rename/delete conflict: mutation error remains in its dialog; no optimistic URL or breadcrumb change.
- Provider tab active: folder queries may stay cached, but folder UI, current-folder empty states, and folder mutations are hidden. Returning to Library restores the URL-selected folder.

The local toolbar remains visible when folders exist even if the current media count is zero, so editors can search folder names, change view, and manage folders.

## Authorization, privacy, and direct access

- Browsing and current-folder reads use existing `media:read`.
- Create, rename, and delete controls require editor level and the server's `media:edit_any` check remains authoritative.
- Single-media Location honors `media:edit_own`/`media:edit_any` ownership rules.
- All writes use `apiFetch`, retaining CSRF protection.
- Folder names are shared media metadata; no user-private folder state is introduced.
- Direct URL access cannot reveal folder data without `media:read`.

## Accessibility, localization, RTL, and responsive behavior

- Every visible string, toast, error, empty state, title, label, and aria label uses Lingui.
- Do not commit `messages.po` changes.
- Use logical Tailwind classes only. Back chevrons use `rtl:-scale-x-100` or a bidi-aware icon.
- Kumo Breadcrumbs has a navigation label. Current folder is text, root is a router-aware link.
- Folder cards have one descriptive link and one **Edit folder** button; no nested anchors/buttons or click-only containers.
- Dialog focus is trapped by Kumo. Create autofocuses Name. Close restores the invoking control. Delete confirmation returns focus to Delete on cancel.
- Pending folder/media content uses `aria-busy` and inert controls consistently with the current library. Folder load completion and result changes receive a polite announcement.
- Folder cards use 4/3/2/1 columns. At 320 CSS pixels, no horizontal overflow is allowed; header actions, toolbar, Location field, dialogs, and pagination remain reachable.
- Verify Arabic direction with Back, breadcrumbs, folder cards, dialog footer, Combobox, list rows, and paginator together.
- Respect reduced motion; do not add custom folder enter/exit animation.

## Compatibility and cost

- Existing media requests that omit `folderId`, media picker flows, providers, plugins, CLI, and MCP remain All media.
- The main Media page changes its root request from omitted `folderId` to `folderId=unfiled`; all existing media is initially unfiled, so the visible result is unchanged until users assign folders.
- Named-folder navigation adds one current-folder query. The bounded folder-list query runs only at root, during global filename search, or while the Location Combobox is open.
- Each folder-list request returns at most 100 rows. Additional work occurs only after explicit **Load more folders**.
- No folder count, N+1 media count, automatic cursor drain, logged-out query, storage operation, or usage reindex is added.
- PR2 adds an additive core GET route and admin UI. It requires an `emdash` minor and `@emdash-cms/admin` minor changeset unless maintainers coordinate the two stacked PRs into one release entry.

## Test plan

### Core and admin API

- Current-folder GET returns the folder, requires `media:read`, validates IDs, returns 404 after deletion, appears in OpenAPI, and encodes typed-client IDs.
- Admin folder list pagination preserves cursors, serializes independent bounded page and Location searches, maps Main library to `unfiled`, encodes path IDs, sends exact bodies, and surfaces server messages.
- No picker/provider/upload request gains `folderId`.

### Router and data state

- Root, named folder, global search, MIME filter, page reset, page-size preservation, and query keys map to the documented API options.
- Folder-card navigation clears search; Back preserves it.
- Direct missing folder replaces root once.
- Re-entering a just-deleted folder through browser Forward or a direct URL cannot render its cached name and recovers to root once.
- Folder create, rename, delete, and media move invalidate only the required query prefixes.
- Equal Media-page and Location search terms keep independent cursor pages; loading more in one surface does not extend the other.
- Existing keep-previous-data, page recovery, paginator focus, scroll position, and no-layout-shift tests remain green.

### Components

- Grid and list render folders before media on page 1. They hide for MIME filters, later asset pages, providers, and named folder pages without search; a searched named-folder page renders global matching folders before global matching media.
- Folder card link/edit semantics, permission visibility, Unicode names, long-name truncation, touch access, and focus restoration work.
- Create/edit dialog covers autofocus, Enter, trim/length validation, duplicate inline error, unknown error, loading, duplicate submit, rename, delete cancel, safe-delete copy, success toast, and focus return.
- Location covers Main library, independent search and pages, named folder, load-more, current option injection, ownership, every local MIME family, provider exclusion, combined metadata/folder save, concurrent selected-folder deletion, replacement of the open detail item, stale folder error, discard confirmation, and disappearing-card focus.
- Tests assert behavior and accessible names, not Tailwind class literals.

### Browser and visual verification

Add a main Media Library E2E flow:

1. Create two folders.
2. Move an existing media item into one folder.
3. Enter the folder, reload, and use browser Back.
4. Search globally, then open a folder and confirm search clears.
5. Rename the current folder.
6. Delete it and confirm the media remains reachable in Main library with the same ID and URL.
7. Confirm authors can move their own media but cannot manage folders.

Run accessibility scans on the populated root, folder page, create/edit/delete dialogs, and open Location Combobox. Add 320-pixel mobile interaction coverage and update the main Media Library visual baseline in English and Arabic after maintainer review.

## Expected files and line budget

Expected production files:

- `packages/core/src/api/handlers/media-folders.ts`
- `packages/core/src/api/openapi/document.ts`
- `packages/core/src/api/schemas/media.ts`
- `packages/core/src/database/repositories/media-folders.ts`
- `packages/core/src/astro/routes/api/media/folders/index.ts`
- `packages/core/src/astro/routes/api/media/folders/[id].ts`
- `packages/core/src/client/index.ts`
- `packages/admin/src/lib/api/media.ts`
- `packages/admin/src/lib/api/client.ts`
- `packages/admin/src/lib/api/index.ts`
- `packages/admin/src/router.tsx`
- `packages/admin/src/components/MediaLibrary.tsx`
- `packages/admin/src/components/MediaFolderDialog.tsx`
- `packages/admin/src/components/MediaDetailPanel.tsx`
- narrow test helpers or one folder-card component only if the main component becomes harder to read

Expected tests:

- focused core route/OpenAPI/client tests;
- admin media API tests;
- `MediaLibrary`, folder dialog, Media Details, and router tests;
- main media E2E and accessibility coverage;
- English/Arabic visual baselines when accepted by a maintainer.

Expected documentation and release files:

- `docs/src/content/docs/guides/media-library.mdx`
- one changeset for `emdash` and `@emdash-cms/admin`
- no locale catalogs

Projected size:

| Area                                           | Production lines | Test lines | Docs/changeset lines |
| ---------------------------------------------- | ---------------: | ---------: | -------------------: |
| Current-folder GET, folder search, and clients |          115–165 |    120–180 |                    0 |
| Router state and folder queries/mutations      |          130–190 |    110–170 |                    0 |
| Folder header/grid/list/dialog UI              |          240–330 |    200–300 |                    0 |
| Media Details Location                         |           90–130 |    100–160 |                    0 |
| E2E, accessibility, docs, release              |                0 |     80–140 |                15–30 |
| Total                                          |          575–815 |    610–950 |                15–30 |

Treat 815 production lines as a warning threshold. Stop for scope review above 875. Block implementation above 975 production lines, or if it adds nesting, counts, automatic all-folder loading, bulk mutation, drag/drop, upload placement, picker/provider behavior, or a folder navigation framework.

## Implementation sequence

Every commit follows:

`plan → meaningful failing tests → implementation → adversarial review → patch → re-review → checks → scope audit → local commit`

### Commit 1: Add direct folder reads and admin data orchestration

Responsibility: Add current-folder GET and bounded folder-search contracts, admin folder API functions/types, folder URL state, bounded folder queries, and folder-aware media query mapping.

Acceptance criteria:

- Direct folder URLs resolve one folder or recover to root.
- Root, folder, global search, and MIME filters send the documented media request.
- Folder query state exposes `hasNextPage` and `fetchNextPage` for the visible load-more UI added in Commit 2.
- Existing pagination, upload, picker, provider, and cache behavior remains unchanged.

Expected size: 230–320 production lines and 210–320 test lines.

Explicit exclusions: no folder cards, dialogs, Location control, upload placement, nesting, or bulk behavior.

### Commit 2: Add Strapi-style folder browsing and management

Responsibility: Add Back/breadcrumb/header actions, folder-first grid/list rendering, create/edit/delete dialogs, permissions, focus, and empty/error states.

Acceptance criteria:

- Stable Strapi's compatible labels, action placement, ordering, dialog footer, and responsive card progression are reproduced.
- Folder grid and list expose **Load more folders** only when their bounded query has another page.
- Safe-delete wording accurately describes Main library behavior.
- Folder controls stay local-only, localized, RTL-safe, keyboard accessible, and editor-gated.
- Root/folder navigation and folder mutations compose with numbered pagination without refresh feel or layout jumps.

Expected size: 250–350 production lines and 230–350 test lines.

Explicit exclusions: no counts, nested Location tree, folder selection, bulk actions, drag/drop, upload placement, picker, or providers.

### Commit 3: Add single-media Location and release documentation

Responsibility: Add ownership-aware Location editing for local media, complete browser/accessibility/RTL coverage, update the guide, and add the changeset.

Acceptance criteria:

- Authors can move their own local media; editors can move any local media.
- Folder assignment composes atomically with image metadata and works for non-images.
- The Location Combobox starts its independent bounded query only when opened and exposes **Load more folders** only when another page exists.
- Moving an item out of the current view closes cleanly and restores focus.
- Main library, stale-folder, provider, pending, and discard states are correct.
- Docs describe only shipped folder workflows and state that uploads enter Main library.

Expected size: 100–160 production lines, 150–260 test lines, and 15–30 docs/changeset lines.

Explicit exclusions: no upload placement, bulk move, folder tree, picker, CLI, MCP, or media/storage schema changes.

## Acceptance criteria

PR2 is complete when a reader can browse Main library folders, an editor can create/rename/delete a folder, an authorized user can move one local media item through Media Details, direct folder URLs and Back work, and safe deletion returns media to Main library. The UI matches stable Strapi's compatible folder workflow without adopting hierarchy or destructive semantics. Pagination remains stable, providers and pickers remain unchanged, and all UI is localized, RTL-safe, responsive, and accessible.

All affected unit, browser, E2E, OpenAPI, typecheck, lint, formatting, build, docs, and changeset checks must pass. PostgreSQL is relevant to the additive core folder-read and folder-search changes and may be reported unavailable locally when `EMDASH_TEST_PG` is unset.

## Decisions to approve

This specification recommends:

1. The admin root becomes Main library, matching Strapi; the API's All media mode remains available to existing callers but is not exposed in PR2 UI.
2. PR2 adds `GET /media/folders/:id` for direct URLs and `q` on the bounded folder list for complete search, instead of automatically loading every folder page.
3. Search is library-wide like stable Strapi. With search plus MIME, both filters are library-wide; MIME without search remains folder-scoped. Any MIME filter hides folder cards.
4. Upload controls are available only at the Main library root; upload-to-folder waits for a deduplication placement rule.
5. Folder pages use explicit bounded **Load more folders** rather than hidden or unbounded folder loading.
6. Stable Strapi's hierarchy, counts, bulk operations, drag/drop, and destructive delete are deliberate non-goals.
7. Implementation remains blocked until maintainers confirm Discussion coverage for the folder feature.
