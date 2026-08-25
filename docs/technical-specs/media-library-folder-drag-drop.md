# Drag local media into flat folders

Status: Approved for local implementation by the current thread
Dependency: Draft PR [#2586](https://github.com/emdash-cms/emdash/pull/2586) at
`feat/media-folders-ui` commit `3fac5486`, stacked on folder API PR
[#2584](https://github.com/emdash-cms/emdash/pull/2584)
Intended position: focused follow-up commits on PR2 before it is pushed again
References: stable Strapi Media Library and its experimental single-item drag implementation at
Strapi commit `e8b156d3a629`; EmDash keeps the stable UI hierarchy and borrows only the bounded drag
mechanics described below

## Authority

The current invocation combines `$feat-tech-spec` and `$feat-implement`. It authorizes this
specification, the scoped source and test changes, public documentation and changeset updates, and
focused local commits. It does not authorize pushing the branch, modifying either draft pull
request, changing the stack, merging, releasing, or deploying.

This document supersedes only the drag-and-drop exclusions in the PR2 and visual-polish
specifications. Their remaining product, compatibility, visual, and review gates continue to apply.

## Purpose

Allow a user to move one visible local media item into one visible flat folder by dragging its grid
card or list row onto the folder card or row. The move uses the folder assignment API and permission
rules already delivered by PR1.

The interaction is an optional shortcut. **Media Details → Location** remains the complete
click/touch and keyboard path for moving media, including moving an item back to the Main library.

## Scope

### Included

- Drag one local media item from the current grid or list onto one visible folder.
- Support root results and library-wide filename-search results when folder targets are already
  visible under the existing folder-query rules.
- Use the existing ownership-aware `canMoveMedia` decision and `PUT /media/:id` folder assignment.
- Show a compact drag preview, hovered valid-target treatment, moving state, success feedback, and
  failure feedback.
- Preserve card/row click behavior, folder navigation, edit actions, responsive layout, RTL, and
  the existing external-file upload drop zone.
- Test grid, list, cancellation, same-folder no-op, permissions, pending requests, provider
  isolation, failure recovery, pointer geometry, accessibility, and the persisted media URL.
- Update the Media Library guide and PR2 changeset with the observable shortcut.

### Excluded

- Dragging folders, folder-to-folder moves, nesting, parent selection, or folder reordering.
- Multi-select, bulk drag, selection state, drag badges, or mixed media/folder payloads.
- Dropping onto the Main library, breadcrumbs, Back, the sidebar, a folder tree, or Media Details.
- Uploading files into the hovered folder or changing direct/signed upload contracts.
- Media Picker, content fields, Portable Text, provider media, CLI, MCP, plugin, import, schema,
  migration, storage, usage, query, route, permission, or core/server public API changes. The one
  allowed additive surface is the optional exported `MediaLibraryProps.onMoveMedia` admin prop,
  covered by PR2's existing `@emdash-cms/admin` minor changeset.
- Optimistic removal, undo, offline queues, cross-tab coordination, or drag history.
- Keyboard drag controls. The existing Location control is the keyboard-equivalent operation.
- Copying Strapi's unstable folder dragging, recursive hierarchy validation, or bulk-move API.

## Verified current behavior

### EmDash PR2

- `MediaLibrary` renders local `MediaGridItem` buttons and local `MediaListItem` table rows. Provider
  items have separate components and data contracts.
- Visible folder grid cards and list rows already preserve explicit link and edit-button semantics.
- `canMoveMedia` permits editors to move any local media and authors to move their own media.
- `updateMedia(id, { folderId })` returns the updated local media item and uses the normal CSRF and
  API-error path.
- The route's `['media', ...]` query and current folder filters already produce the correct list
  after invalidation.
- Whole-page native file drag reacts only to `dataTransfer.types` containing `Files`. A dnd-kit
  pointer drag has no file `DataTransfer`, so the upload overlay does not need a second drag system
  or shared guard.
- `@dnd-kit/core` and `@dnd-kit/utilities` are existing admin dependencies. Other admin surfaces use
  an 8px pointer activation distance.
- Media Details provides a Kumo Location Combobox for click, touch, and keyboard movement. It is
  lazy, bounded, permission-aware, and supports the Main library.

### Strapi reference

Stable Strapi keeps folders before media and uses lightweight horizontal folder surfaces. Its
experimental Assets implementation adds:

- one active item per drag;
- `PointerSensor` with an 8px activation distance;
- `pointerWithin` collision detection;
- folder-only drop targets;
- a small filename drag chip;
- `DragOverlay` with no drop animation;
- target validation before mutation;
- pending-mutation guards; and
- localized live and toast feedback.

EmDash uses those mechanics without adopting Strapi's folder dragging, bulk endpoint, complete
folder tree, hierarchy checks, or unstable page architecture.

## Interaction contract

### Eligibility

A media item is draggable only when all of the following are true:

- the active provider is local;
- the item satisfies `LocalMediaItem`;
- at least one folder target is visible;
- `onMoveMedia` is supplied;
- `canMoveMedia(item)` returns true; and
- no media move is pending.

Folder-management permission is not required. An author may drag an owned item into a shared folder
even when the edit-folder button is absent.

Provider items, read-only local items, media rendered while folders are hidden by page/filter state,
and external `MediaLibrary` consumers without the additive move callback retain their current
behavior and markup.

### Start and cancellation

- Pointer movement must exceed 8px before a drag begins. An ordinary click still opens Media
  Details.
- Disable native image dragging on draggable local thumbnails so the browser does not start an
  image URL drag.
- Starting a drag records one immutable local item, dims its source, changes its cursor, and renders
  a compact Kumo drag preview containing a file icon and filename. The preview is bounded to the
  viewport and may truncate visually; the unchanged source control retains the complete accessible
  name.
- Escape, pointer cancellation, or release outside a valid folder clears all drag state and sends no
  request. The source returns to its normal geometry and click behavior.
- Browser interruption (`blur`, resize, or the document becoming hidden) clears suppression because
  dnd-kit cancels those gestures without guaranteeing a later pointer event in this window.
- `DragOverlay` uses no drop animation. No routine hover or target color transition is added.
- Starting a real drag arms one short-lived click-suppression ref. The Media Library root consumes
  the release-generated click in capture phase with both `preventDefault()` and `stopPropagation()`,
  then clears the ref. Escape cancellation does not clear suppression; it remains armed through the
  gesture's actual pointer release. A window-level `pointerup` listener schedules fallback clearing
  in the next task only when no click was dispatched, which also covers drops outside the root.
  An actual `pointercancel` clears it directly. Sub-threshold pointer movement never arms
  suppression.

### Folder target

- Grid mode makes the existing `LayerCard` the drop target. List mode makes the existing folder row
  the drop target without changing its table role or adding a new column.
- A valid hovered target uses semantic Kumo tokens plus a dashed/outlined boundary so color is not
  the only indication.
- Folder link and edit-button behavior remain unchanged when no drag is active.
- A folder whose ID already equals the active item's `folderId` is disabled as a target. Releasing
  over it performs no request and announces no success.
- Only `pointerWithin` selects a target. Passing near a folder or ending between cards must not move
  media.

### Success

1. Revalidate the active item, target folder, permissions, same-folder condition, and pending guard.
2. Call the additive `onMoveMedia(item, folder)` callback once.
3. The route callback calls `updateMedia(item.id, { folderId: folder.id })`.
4. Await invalidation of the `['media']` query so folder/root/search results reflect committed server
   state before the move resolves.
5. Announce and toast that the named file moved to the named folder.
6. Focus the Media Library heading with `preventScroll` if the source leaves the current result set.

Do not optimistically remove or edit the media row. IDs, URLs, storage keys, usage records, content
references, page size, filters, folder cursors, and folder order do not change.

### Failure and concurrency

- One move may be pending at a time. Disable every draggable source and drop target until it settles.
- A second drag or duplicate drop while pending sends no request.
- On every failed request, refresh `['media']`. If the media or folder disappears, keep the current
  rendered results only while recovery runs and also refresh `['media-folders']` and
  `['media-folder']` for `NOT_FOUND`. Await those reads before the move callback rejects and dragging
  re-enables, so deleted sources and targets disappear when the refresh succeeds.
- If authorization fails with HTTP status 401 or 403, call and await
  `queryClient.resetQueries({ queryKey: ['currentUser'], exact: true })` before dragging re-enables.
  Reset removes the cached role before its active refetch, so a failed authentication refresh leaves
  move eligibility disabled instead of restoring the stale editor record. The refreshed user record,
  not the cached pre-drop decision, determines later eligibility. Server authorization remains
  authoritative for the attempted move.
- Map `ApiResponseError.code` to localized move feedback: missing media/folder, permission lost, and
  a generic failure. Never render the raw server `error.message` in Toast or the live region.
- Announce failure politely, show the mapped localized error toast, and allow another drag after
  recovery settles.
- A failed move does not navigate, open Media Details, clear search, change filters, or change
  pagination.
- Query invalidation belongs to the route callback. The UI callback contract resolves only after
  the parent has refreshed the media query.

## Internal component contract

Add one optional prop to exported `MediaLibraryProps`:

```ts
onMoveMedia?: (item: LocalMediaItem, folder: MediaFolder) => Promise<void>;
```

This is additive. Existing consumers compile and behave as before.

Inside `MediaLibrary`:

- wrap the current surface in one `DndContext`;
- use `PointerSensor` with `{ distance: 8 }` and `pointerWithin`;
- use prefixed drag and target IDs so media IDs cannot collide with folder IDs;
- keep narrow `MediaDragData` and `MediaFolderTargetData` discriminated records;
- use `useDraggable` only inside local media components and `useDroppable` only inside folder
  components;
- attach pointer listeners and refs without spreading synthetic button/list roles onto table rows;
- render an `aria-hidden` Kumo drag overlay;
- keep a stable polite live region for repeated move results; and
- use a component-owned `createKumoToastManager` and internal `Toasty` host for visible success and
  failure feedback, so existing direct `MediaLibrary` consumers do not acquire a provider
  prerequisite.

The route callback owns recovery as well as persistence. On success it awaits the media invalidation.
On failure it awaits the code-specific invalidations above, then rethrows the original error so the
component can choose localized feedback without losing the stable API code.

Do not introduce a general drag framework, new package, global context, reducer, store, or reusable
folder tree.

In `MediaPage`, add a stable callback that calls `updateMedia` and awaits `queryClient.invalidateQueries({
queryKey: ['media'] })`. Pass it alongside the existing `canMoveMedia` function.

## Accessibility, localization, RTL, and responsive behavior

- Grid buttons retain their accessible name and Enter/Space behavior for opening Media Details.
- Table rows retain table semantics. Dnd-kit roles or keyboard listeners must not be added to `tr`.
- Media Details Location remains the documented keyboard and single-pointer alternative required by
  WCAG 2.5.7.
- The drag preview is decorative to assistive technology. Stable polite text announces successful
  and failed moves; Toast supplies the visible equivalent.
- Every new message and accessible label uses Lingui. User filenames and folder names render with
  `dir="auto"` inside the drag preview and messages do not assemble JSX from separately translated
  fragments.
- Drop boundaries use logical layout and do not move edit actions, links, table columns, cards, or
  pagination in LTR or RTL.
- At 320px, pointer drag may target the visible one-column folder cards. The interaction must not
  create document overflow or change the existing card width. The overlay uses a viewport-relative
  maximum width, `dir="auto"`, and visual truncation; the source preserves the full accessible name.
  Location remains available when a precise drag is inconvenient.
- Reduced-motion users receive no drop animation or custom source/target movement.

## Test plan

### Component and router behavior

Add browser-mode component tests that prove:

- a movable local grid item and list item can be dragged to a different folder exactly once;
- a sub-threshold pointer move remains a click and opens Media Details;
- a completed drag does not also open Media Details or navigate into the target folder;
- the dragged image cannot start a native image drag;
- dropping outside, canceling, and dropping on the current folder send no request;
- `canMoveMedia: false`, missing `onMoveMedia`, hidden folders, providers, and a pending move disable
  dragging;
- valid grid and list targets gain and clear their visual state without layout movement;
- success and failure feedback contains the complete media and folder names;
- failure preserves the source and allows retry; and
- `NOT_FOUND` refreshes media and folder query families, HTTP 401/403 resets the current user, and
  route-level deferred tests prove the move stays pending until those recovery reads settle;
- the release click after a completed or canceled drag cannot open Media Details, a folder link, or
  a folder edit action, while a later normal click still works;
- long filenames keep the overlay and document within a 320px viewport; and
- the existing whole-page file-drop upload flow remains green.

Add router tests that invoke the move callback through the mocked `MediaLibrary` and prove:

- success calls the existing update client once and awaits media invalidation;
- `NOT_FOUND` awaits media, folder-list, and current-folder query refreshes before rejecting; and
- HTTP 401/403 resets and awaits the exact current-user query before rejecting, leaving move
  eligibility disabled if that refresh fails.

Use deferred responses or query functions so each test can prove the callback remains pending until
recovery settles. Existing route permission and API tests remain authoritative for server rejection.

### Playwright and visual verification

Extend `e2e/tests/media-library.spec.ts` with a bounded flow that:

1. uploads one uniquely named and hashed image, creates a unique folder, and records its media URL;
2. pointer-drags the media grid card into the folder;
3. proves Media Details did not open, the item leaves the Main library, and the exact URL appears in
   the target folder;
4. deletes the folder and waits until the media returns to Main;
5. repeats the move from list view using a second unique folder;
6. forces a rejected move and proves the error feedback, unchanged source, and successful retry;
7. repeats target geometry checks at 320px and Arabic RTL; and
8. deletes every created folder and the uniquely uploaded media before the next serial test begins.

Extend the Media Library axe audit while a drag target is active and after failure feedback. Use
screenshots as a per-commit review gate, not committed snapshots.

Manual screenshots must include:

- 1512×982 grid source, drag preview, and hovered folder in light and dark themes;
- 1512×982 list hovered folder row;
- 320×800 one-column folder target;
- Arabic RTL with a long Latin filename and folder name; and
- failure feedback with the source still present.

## Documentation and release note

Update the Media Library guide to state the two move paths:

- drag a local media card or row onto a visible folder; or
- open Media Details, choose Location, and save.

State the author/editor permission boundary once. Keep Location as the path for Main library moves.
Correct the root upload action label to **Upload Files** while editing the same page.

Update the existing PR2 changeset rather than adding another one. Mention drag-to-folder as an
available shortcut; keep the Main-library upload and safe-delete behavior unchanged.

## Expected files and line budget

Expected production files:

- `packages/admin/src/components/MediaLibrary.tsx`
- `packages/admin/src/router.tsx`

Expected tests:

- `packages/admin/tests/components/MediaLibrary.test.tsx`
- `packages/admin/tests/router.test.tsx`
- `e2e/tests/media-library.spec.ts`
- `e2e/tests/accessibility.spec.ts`

Expected documentation:

- `docs/technical-specs/media-library-folder-drag-drop.md`
- `docs/src/content/docs/guides/media-library.mdx`
- `.changeset/media-library-folder-ui.md`

Projected additions:

| Area                                                 | Production lines | Test lines | Documentation lines |
| ---------------------------------------------------- | ---------------: | ---------: | ------------------: |
| Drag context, source/target hooks, overlay, feedback |          300–345 |    290–390 |                   0 |
| Route callback and invalidation                      |            20–35 |    190–250 |                   0 |
| Playwright and accessibility coverage                |                0 |    110–180 |                   0 |
| Guide and changeset                                  |                0 |          0 |                8–20 |
| Technical specification                              |                0 |          0 |             390–430 |
| Total                                                |          320–380 |    590–820 |             398–450 |

Adversarial design review added provider-safe Toast ownership, code-specific stale-query recovery,
cached-auth reset, release-click suppression, interruption cleanup, and deferred route proofs. The
revised ranges include those required contracts. The user explicitly approved additional in-scope
code for this follow-up.

Treat 380 production lines as a warning threshold. Stop for scope review above 420 production lines.
Block above 470 production lines or if implementation adds an API, schema, migration, dependency,
folder hierarchy, bulk behavior, selection model, upload placement, provider/picker behavior, or
general drag framework.

## Implementation sequence

Every commit follows:

`plan → failing behavior tests → implementation → browser interactions/screenshots → Terra X-High review → patch → re-review → checks → scope audit → local commit`

### Commit 1: Move one local media item into a visible folder

Responsibility: add the complete pointer drag shortcut in grid and list modes using the existing
single-media folder assignment.

Acceptance criteria:

- Eligible local media and visible folder targets follow the interaction, permission, concurrency,
  failure, accessibility, provider, file-upload, and visual contracts above.
- The route callback persists one assignment and awaits media invalidation.
- Grid/list success, cancellation, same-folder, permissions, pending state, provider isolation,
  failure, ordinary click, and native upload-drop behavior have meaningful browser component tests.
- The full Media Library Playwright move flow passes before this commit is reviewed.

Expected size: 320–380 production lines and 590–820 test lines.

The technical specification is committed with this implementation slice.

Explicit exclusions: public guide prose, changeset prose, public APIs other than the documented
additive `MediaLibraryProps.onMoveMedia` admin prop, bulk selection, Main-library drop, folder
dragging, hierarchy, and upload placement.

### Commit 2: Document and release the drag shortcut

Responsibility: make the user guide and PR2 release note describe the verified interaction.

Acceptance criteria:

- The guide presents drag and Location as two paths, retains the permission rule, explains how to
  return to Main library, and uses the current **Upload Files** label.
- The changeset mentions the drag shortcut without internal mechanics or PR prose.
- Docs build, formatting, link checks available locally, the complete Media Library E2E flow, and
  final visual screenshots pass before commit.

Expected size: 8–20 public documentation lines.

Explicit exclusions: new screenshots in public docs, API reference changes, translation catalogs,
and additional production behavior.

## Final acceptance criteria

The follow-up is complete when:

- both commits are locally committed and independently reviewed;
- the final tree satisfies every interaction and failure state above;
- the Media Library guide and changeset match the rendered behavior;
- component, router, Playwright, axe, lint, typecheck, format, admin build, docs build, and combined
  branch checks pass;
- no generated catalogs, lockfile, query-count snapshot, visual baseline, or unrelated file changed;
- Terra X-High review of the complete PR2 diff against `feat/media-folders-api` has no material
  finding; and
- the branch remains unpushed and both GitHub draft PRs remain unchanged.
