# Direct multi-file uploads in the media library

Status: Implemented
Base: `origin/main` at `e7978d3d`
Intended stack position: One focused `@emdash-cms/admin` feature PR
Authority: Local implementation and commits approved. Pushes and GitHub changes remain unauthorized.

## Summary

Replace the media library's sequential file-picker upload with one direct multi-file upload flow. An
administrator can select **Upload to Library** to open the upload dialog, then add files from its
dropzone or file picker. Files can also be dragged anywhere over the media-library window. A
page-wide overlay with a blurred backdrop and dashed drop boundary appears during a file drag.
Adding or dropping files starts a bounded upload queue immediately.

The dialog follows the simpler composition of a dropzone, file list, per-file metadata, status, and
file actions. It uses React, Kumo, Phosphor icons, Lingui, and Tailwind already present in the admin
package. It does not install Dice UI, import `@base-ui/react` directly, copy the reference component
or its hooks, add `motion`, or change a package manifest or lockfile.

## Approved product direction

- File selection and file drop mean **upload now**.
- There is no review-only staging state and no **Upload N files** confirmation.
- The UI shows honest `queued`, `uploading`, `complete`, and `failed` states.
- EmDash does not show simulated percentages. The existing Fetch-based client does not expose upload
  progress bytes.
- The dialog provides actions only when the user needs to add more files, cancel, retry, clear
  completed rows, or finish.

## User outcome

An administrator can add a batch of media to the active library with one selection or drop, see the
status of every file, cancel unfinished work, and retry individual failures without selecting the
whole batch again.

## User stories

### Upload by dragging files

As an administrator, I want to drag several files anywhere over the media-library window so that I
can upload them without locating a small drop target.

Acceptance path:

1. Dragging files into the window shows a blurred overlay and dashed boundary.
2. The overlay says **Drop files to upload**, making the immediate side effect explicit.
3. Dropping opens the upload dialog and starts the files automatically.
4. Leaving the window without dropping removes the overlay and starts nothing.

### Upload from the page action

As an administrator, I want **Upload to Library** to open the upload dialog so that I can see the
available dropzone and file controls before choosing files.

Acceptance path:

1. Select **Upload to Library** or the empty-state **Upload Files** action.
2. The empty upload dialog opens.
3. Select **Browse files** or drop files on the dialog dropzone.
4. Confirming the file picker or dropping files starts them automatically.

### Monitor and recover a batch

As an administrator, I want each file to show its own status and recovery actions so that one failure
does not hide or restart successful uploads.

Acceptance path:

1. Every file shows a preview or type icon, filename, size, and text status.
2. The queue continues after a failure.
3. A failed file can be retried by itself, and all failed files can be retried together.
4. A queued or uploading file can be canceled without affecting completed files.
5. Completed files appear in the media library and are never restarted by retry actions.

## Scope

### Included

- A page-wide file-drag overlay on the media-library route.
- An empty upload dialog opened by the header and empty-state actions.
- Direct uploads from the dialog file picker, dialog dropzone, and page drop.
- One Kumo dialog containing a compact dropzone and composable file list.
- Bounded parallel uploads with independent file states.
- Per-file cancellation, removal, failure, retry, and completion.
- Batch **Cancel remaining**, **Retry failed**, **Clear completed**, and **Done** actions.
- Local media-library uploads and external providers whose `upload` capability is true.
- Real request cancellation through `AbortSignal` where the upload client honors it.
- Localized, keyboard-accessible, RTL-safe, responsive UI.
- A patch changeset and a short media-library guide update.

### Excluded

- A review or confirmation step before upload.
- Byte-level progress percentages, circular progress, or fill progress.
- Resumable or chunked uploads.
- Upload persistence across navigation, reload, tab close, or browser restart.
- Background uploads after the dialog closes.
- Changes to server upload routes, storage adapters, database tables, media cleanup, permissions,
  MIME allowlists, or maximum upload size.
- Changes to `MediaPickerModal` or field-specific upload flows.
- Directory traversal from a dropped folder.
- Automatic retries, retry backoff, or a global upload manager.
- Installing `@diceui/file-upload`, importing `@base-ui/react`, or copying its direction/ref hooks.
- Reproducing the reference component as a new public EmDash primitive. The first consumer remains
  the media library.

## Verified current behavior

- `MediaLibrary` renders a hidden multiple file input. Both upload actions open that input directly.
- Selecting files immediately uploads them one at a time. The page shows one aggregate status line
  and does not expose individual failures or retries.
- The local library delegates each file to the public `MediaLibraryProps.onUpload(file)` callback.
  `MediaPage` implements that callback with `uploadMedia(file)` and invalidates the media query after
  each success.
- External provider uploads call `uploadToProvider(activeProvider, file)` directly from
  `MediaLibrary`, then refetch that provider.
- `uploadMedia` already selects the correct local multipart, same-origin streaming, signed R2/S3,
  or deduplicated path. The UI must reuse it rather than introduce another transport.
- Local uploads abandoned after the upload-target request leave a pending media row. Existing core
  cleanup makes those rows and associated storage objects eligible for removal after one hour.
- The server remains authoritative for permissions, MIME type, file size, storage errors, and
  deduplication.
- `MediaLibrary` is a public admin component. The upload dialog can remain an internal implementation
  detail.

## Interaction model

### Use case 1: Drag files over the media-library window

Given the media-library route is mounted, the dialog is closed, and the active provider supports
upload:

1. A drag whose `DataTransfer.types` includes `Files` enters the browser window.
2. EmDash prevents the browser from navigating to the local file.
3. A fixed overlay covers the viewport. It uses a translucent Kumo surface, a small backdrop blur,
   and an inset dashed boundary with an upload icon and **Drop files to upload**.
4. The overlay does not appear for selected text, links, or other non-file drags.
5. Leaving the window without dropping removes the overlay and changes no upload state.
6. Dropping files removes the overlay, snapshots the active provider, opens the upload dialog, and
   immediately queues every accepted file.

Use a drag-depth counter because `dragenter` and `dragleave` fire while crossing child elements.
Reset the counter on `drop`, window exit, component unmount, and dialog open. The overlay is
presentational and `pointer-events: none`; window listeners own the page drop behavior.

When the active provider cannot upload, EmDash still prevents file-drop navigation but does not show
the overlay or open the dialog. While the dialog is open, suspend the page overlay and let the
dialog's dropzone accept additional files.

### Use case 2: Open the dialog from a page action

Selecting **Upload to Library** or the empty-state **Upload Files** action snapshots the active
provider and opens the empty upload dialog. It does not open the system file picker. Selecting
**Browse files** inside the dialog opens its multiple file input; confirming the picker queues the files
immediately.

Reset the dialog input value after every selection so selecting the same file again produces a new
change event. Do not silently deduplicate files with identical names, sizes, or modification times.
The server's content deduplication remains authoritative.

### Use case 3: Browse or drop files in the upload dialog

The open dialog contains a spacious dashed dropzone and a **Browse files** Kumo button. Dropping or
choosing more files immediately appends them to the existing queue. New files can join a running
batch and start when a concurrency slot is free.

The dialog description states **Files upload as soon as you add them**. The dropzone itself is not a
second custom button; the native file input is activated through **Browse files**, avoiding a duplicate
keyboard stop.

The dialog owns one hidden multiple file input for **Browse files**. It uses the media-library accept
list and resets its value after each selection.

The dialog target remains the provider captured when the first files opened it. The background is
inert, so the user cannot switch provider tabs until the dialog closes.

### Use case 4: Monitor file states

Each file row shows:

- a lazy local preview for JPEG, PNG, GIF, or WebP files no larger than 8 MB, otherwise a Phosphor
  type icon;
- a two-line truncated filename, the full value in its accessible name, and a native title;
- formatted file size;
- a text status and icon, not color alone;
- a contextual action with the filename in its accessible name.

An uploading row shows a Kumo loader and **Uploading**. It does not show a percentage. Completed rows
show **Complete**. Failed rows show the localized text **Upload failed** without rendering arbitrary
messages thrown by a custom callback. A stable polite live region announces aggregate changes such
as **3 of 8 uploads complete** and **2 uploads failed**.

### Use case 5: Cancel or dismiss file rows

- Canceling a queued file removes it before its upload starts.
- Canceling an uploading file aborts its request and removes the row. The next queued file starts.
- Removing a failed file discards its retry state.
- Dismissing a completed row changes only the dialog. It does not delete completed media from the
  library. The accessible label is **Dismiss completed filename**, not **Delete filename**.
- **Cancel remaining** aborts and removes every queued or uploading file. Completed and failed rows
  remain visible.
- **Clear completed** dismisses all completed rows without deleting media.

The dialog cannot close from Escape, the backdrop, close controls, or **Done** while a queued or
uploading file remains. The user can wait, cancel individual files, or select **Cancel remaining**.
Once the queue has no unfinished file, closing clears dialog-local rows after Kumo's exit animation.

An abort cannot roll back a request the server has already committed. A file that completes at the
same time as cancellation can appear after the next query refresh. A local upload aborted after
creating an upload target can leave a pending row until existing cleanup runs.

### Use case 6: Retry failures

A failed row retains its `File` object for the current dialog session. **Retry filename** immediately
queues only that file. **Retry failed** immediately queues every failed row. A retry creates a new
upload attempt; it does not resume bytes or reuse a previous signed URL.

Successful files are never restarted by retry-all. When no file is queued or uploading, the user can
close with **Done**, including when failed rows remain.

### Use case 7: External providers

The static dialog title names the captured provider, for example **Upload to Cloudflare Images**.
Queue, cancel, and retry behavior matches the local library. `MediaLibrary` refetches the provider
once when a busy queue becomes idle. Provider errors remain scoped to their rows.

## Upload state machine

| State       | Entered by                              | Available actions                 | Next states                   |
| ----------- | --------------------------------------- | --------------------------------- | ----------------------------- |
| `queued`    | Selection, drop, or explicit retry      | Cancel, cancel remaining          | `uploading`, removed          |
| `uploading` | Scheduler claims a free slot            | Cancel, cancel remaining          | `complete`, `failed`, removed |
| `complete`  | Current upload adapter attempt resolves | Dismiss, clear completed, done    | removed                       |
| `failed`    | Current attempt rejects without abort   | Retry, retry failed, remove, done | `queued`, removed             |

Every row has a generated client ID and attempt number. An async completion updates a row only when
both still match. This prevents an aborted, removed, or retried attempt from overwriting newer state.
An `AbortController` map contains only in-flight attempts.

The scheduler must not depend on rendered state alone because an effect can observe the same queued
entry twice under React Strict Mode. Before dispatching `uploading` or calling the adapter, place the
row ID, attempt number, and controller in the active-controller map. A second scheduler pass skips
that key. The reducer records claimed IDs in one update. When a slot opens, the scheduler selects the
oldest unclaimed queued row.

Unmount aborts active controllers, revokes every preview object URL, and removes window drag
listeners.

## Component design

### `MediaUploadDialog`

Add `packages/admin/src/components/MediaUploadDialog.tsx` as an internal component. Do not export it
from `components/index.ts` in this PR. Compose feature-specific internal parts rather than creating a
general file-upload design system:

- dialog dropzone and trigger;
- upload list;
- upload row preview, metadata, status, and contextual action;
- batch footer actions.

The component receives:

```ts
interface MediaUploadDialogProps {
	open: boolean;
	providerName: string;
	enqueueRequest: { id: number; files: readonly File[] } | null;
	onEnqueueRequestConsumed: (id: number) => void;
	onOpenChange: (open: boolean) => void;
	onCloseComplete: () => void;
	onQueueIdle?: () => void;
	upload: (file: File, options: { signal: AbortSignal }) => Promise<void>;
	concurrency?: number;
}
```

`enqueueRequest` handles files dropped on the page outside the dialog. `MediaLibrary` increments the
request ID for every page drop. The dialog records the last consumed ID before queueing files, so a
parent rerender or Strict Mode effect cannot enqueue the same request again. Files selected from the
dialog's own input or dropped directly on its dropzone use the same internal enqueue function.

After recording the ID and queueing its accepted files, call `onEnqueueRequestConsumed(id)`.
`MediaLibrary` clears the request only when its current ID still matches, releasing the parent's
`File` references without erasing a newer request.

Track whether the queue was busy. Files added or retried while it is busy join the same run. Call
`onQueueIdle` once when queued/uploading count transitions from a positive value to zero, not on
every terminal-state render. A later addition or retry creates another busy-to-idle transition.

Render `Dialog.Root` on every `MediaLibrary` render and control it with `open`; do not conditionally
mount the Kumo dialog. Reset rows, attempts, errors, and object URLs after Kumo reports that the close
animation completed, then call `onCloseComplete`. Retain the last consumed request ID so reopening
cannot replay the previous selection.

Use Kumo buttons, dialog, loader, and semantic tokens. Use Phosphor icons and logical Tailwind
classes. Content text is 14px. Hover color changes are immediate. Optional entrance opacity uses
`motion-safe:` utilities; grid/list reflow snaps and reduced-motion users receive no transform
animation. Clamp a supplied concurrency value to an integer from 1 through 6; production omits it
and uses 3.

### `MediaLibrary`

`MediaLibrary` owns:

- whether the upload dialog is open;
- the page-drag depth and overlay visibility;
- the external enqueue request and captured provider target;
- the adapter for the captured provider;
- local query invalidation or provider refetch behavior already used today.

Replace the page file input with an action that snapshots the active provider and opens the dialog.
Record the page action as the return-focus target. A page drop records the media heading instead.
After dialog close completes, focus the connected initiating element, falling back to the media
heading. This explicit restoration is required because the dialog does not use `Dialog.Trigger`.

Remove the page-level aggregate `uploadState`; the dialog becomes the source of upload feedback.

Keep provider tabs, search, filters, grid/list views, detail panel, and pagination unchanged.

## Upload client contract

Extend the public callback additively:

```ts
export interface MediaUploadOptions {
	signal?: AbortSignal;
}

export interface MediaLibraryProps {
	// Existing props omitted.
	onUpload?: (file: File, options?: MediaUploadOptions) => Promise<void> | void;
}
```

Existing consumers that accept only `file` remain type-compatible. `MediaPage` passes the signal to
`uploadMedia`.

Custom `MediaLibrary` consumers are expected to honor the signal. A legacy callback that ignores it
remains compatible, but EmDash can only stop tracking that attempt; the consumer's work can still
finish. Built-in local and provider adapters must honor cancellation end to end.

Add `signal?: AbortSignal` to the existing option objects for `uploadMedia`, add an optional signal
to `fetchMediaItem` for the deduplicated path, and add a fourth options argument to
`uploadToProvider(providerId, file, alt, options)`. Pass the signal to:

- the upload-target request;
- a local multipart upload;
- a same-origin streaming upload;
- a signed direct-to-storage upload;
- the confirmation request;
- the existing-media fetch in a deduplicated upload;
- an external-provider upload.

Image-dimension probing must settle promptly on abort and always revoke its object URL. Check the
signal after content hashing because Web Crypto digest does not accept an abort signal.

Do not add a cancellation endpoint. Existing abandoned-pending cleanup covers upload targets
created before a client abort.

## Bounds and cost

- Recommended concurrency: `3` per open dialog. The prop exists for focused tests; `MediaLibrary`
  uses the default.
- Recommended visible-row limit: `100` files per dialog. Completed and failed rows count until
  cleared. When an addition exceeds the remaining capacity, enqueue the available prefix and show a
  localized error stating exactly how many files were not added.
- At most three upload flows, content hashes, and dimension probes run concurrently in production.
- Only JPEG, PNG, GIF, and WebP files no larger than 8 MB receive local object-URL previews. Mark
  preview images `loading="lazy"`, create URLs only for rows accepted under the visible-row cap, and
  revoke each URL when its row is removed or the dialog resets.
- Uploads begin only from an explicit selection or a drop target labeled **Drop files to upload**.
- No new database query or logged-out route request is introduced. Uploads and query invalidation
  remain authenticated admin work.
- Retry work is bounded by explicit user actions; there is no retry loop.

## Accessibility, localization, and responsive behavior

- The page upload actions and dialog **Browse files** button provide complete keyboard alternatives to
  drag and drop.
- The hidden file input has a localized label and `multiple`.
- Kumo owns focus trapping and backdrop semantics. `MediaLibrary` explicitly restores focus to the
  initiating page action or media heading after the close animation. The controlled close handler
  refuses dismissal only while unfinished rows remain.
- Every icon-only action has a localized accessible name containing the filename.
- Decorative icons and previews use `aria-hidden="true"` or empty alt text as appropriate.
- A stable `role="status"` with `aria-live="polite"` announces aggregate queue changes.
- Status always has text and an icon; color is supplementary.
- The page overlay is hidden from assistive technology because it has no keyboard action. The page
  upload actions remain available.
- All visible strings, errors, titles, and aria labels use Lingui. Do not edit locale catalogs in the
  feature PR.
- Layout uses logical properties. Test Arabic direction, long filenames, and translated plurals.
- The dialog is a flex column with one vertically scrolling body and a bordered, non-scrolling
  footer. The scroll body uses overscroll containment. Rows reflow without horizontal scrolling at
  320 CSS pixels or 200% zoom.
- Kumo dialog motion and optional CSS opacity honor reduced-motion preferences.
- Dotted boundaries, focus rings, text, and status icons remain visible in light, dark, and
  forced-colors modes.
- Row action targets meet the 24-by-24 CSS-pixel minimum and aim for 40-by-40 where density permits.

## Failure handling

- An empty picker result or drop with no `File` entries does nothing.
- The dialog file picker keeps the current `accept` value. Dropped files are queued without
  client-side MIME rejection; the server remains authoritative and reports unsupported types per
  row.
- A synchronous callback throw and an async rejection both fail only the current row.
- Network, validation, storage, provider, confirmation, and deduplication failures share the
  `failed` state and can be retried.
- An aborted attempt is removed and is not reported as a failure.
- A stale resolution cannot mutate a canceled, removed, or retried row.
- If `onUpload` is absent, local files fail with a localized unavailable message rather than false
  success.
- If the visible-row cap accepts only part of an addition, accepted files start and rejected files do
  not.
- Window listeners, controllers, and preview URLs are released on close, provider change, and
  unmount.
- Browser navigation or tab closure uses native behavior; this PR does not add a before-unload
  prompt.

## Test plan

### Upload dialog browser tests

- The header and empty-state actions open an empty dialog and make no upload callback.
- Confirming the dialog file picker starts callbacks without another action.
- A page drop opens the dialog and starts every accepted file automatically.
- A non-file drag and a drag that leaves the window do not queue files.
- The dialog dropzone and **Browse files** action append files to a running queue.
- The dialog's internal file input remains operable while Kumo marks the background inert and uses
  the media-library accept list.
- The scheduler never exceeds configured concurrency and promotes the oldest queued row when a slot
  opens.
- Removing a queued row prevents its callback; canceling an active row aborts it and frees a slot.
- **Cancel remaining** aborts and removes unfinished rows without changing completed or failed rows.
- One rejection does not stop the queue. Individual retry and retry-all never restart successful
  files.
- A stale aborted or resolved promise cannot overwrite a newer attempt or resurrect a removed row.
- Duplicate filenames and identical metadata remain separate rows.
- A repeated `enqueueRequest` ID is consumed once under Strict Mode. A later ID containing the same
  `File` objects creates new rows and starts them.
- Consuming an external request releases the parent's file references and cannot clear a newer
  request that arrived before the callback was applied.
- The visible-row limit starts only the available prefix, reports the exact rejected count, and
  allows more files after rows are cleared.
- Invalid concurrency test inputs are clamped to the documented 1-through-6 range.
- The dialog cannot dismiss while a file is queued or uploading and restores trigger focus after it
  closes.
- Closing after the exit animation resets rows without replaying the previous enqueue request.
- Queue-idle reporting fires once after additions made during a busy period settle, does not run
  during unmount cleanup, and does not issue repeated provider refetches.
- Completed-row dismissal never calls the media-delete API.
- Aggregate announcements, localized names, long filenames, keyboard order, reduced motion, narrow
  layout, preview cleanup, and Arabic RTL remain usable.

### Media-library integration tests

- Header and empty-state actions open the same empty upload dialog.
- The page overlay appears only for file drags when the captured provider supports upload.
- Dropping on a non-upload provider prevents browser navigation without opening the dialog.
- Local files call `onUpload` automatically with distinct signals.
- Provider files target only the provider captured when the dialog opened and refetch it once after
  a busy queue becomes idle.
- Closing restores focus to the header or empty-state action that opened the picker; a page-drop flow
  restores focus to the media heading.
- Existing search, provider switching, pagination, view mode, and detail-panel tests remain green.

### Upload client tests

- Aborting each local upload path rejects with cancellation and does not send later requests.
- The signal reaches upload-target, direct multipart, signed or same-origin PUT, confirmation,
  deduplicated fetch, and provider requests.
- Aborting image-dimension probing revokes its object URL.
- Existing upload integrity, storage-backend, deduplication, and cleanup suites remain green.

### Manual verification

1. Drag several files from Finder over the library, leave the window, and confirm the overlay clears.
2. Drop the files and confirm the dialog opens and network requests start without another action.
3. Select **Upload to Library**, confirm the empty dialog appears, then add files from the dialog.
4. Browse for more files while uploads are running, cancel one, cancel remaining, and clear completed rows.
5. Force one failure and retry only that file, then retry several failures together.
6. Repeat on local storage, R2/S3-backed storage, and an upload-capable external provider.
7. Complete the flow using only the keyboard.
8. Repeat at 320 CSS pixels, 200% zoom, reduced motion, dark mode, and Arabic RTL.

Run `pnpm lint:quick`, affected browser and API-client Vitest suites, and `pnpm typecheck` after each
implementation round. Before the PR, run formatting, full affected suites, changeset validation,
`git diff --check`, and `pnpm lint:json | jq '.diagnostics | length'`.

## Expected files and line budget

| Area              | Expected files                                                         | Production lines | Test lines | Documentation lines |
| ----------------- | ---------------------------------------------------------------------- | ---------------- | ---------- | ------------------- |
| Abortable clients | `packages/admin/src/lib/api/media.ts`, `packages/admin/src/router.tsx` | 45–80            | 90–140     | 0                   |
| Direct upload UI  | `MediaUploadDialog.tsx`, `MediaLibrary.tsx`                            | 300–420          | 210–300    | 0                   |
| Release/docs      | one changeset, media-library guide                                     | 0                | 0          | 25–45               |
| Total             | 6–8 changed files plus tests                                           | 345–500          | 300–440    | 25–45               |

The warning threshold is 550 production lines or 480 test lines. Stop for scope review at 650
production lines, 580 test lines, any new package dependency, any core/API-route change, or any
second upload abstraction.

## Implementation sequence

The feature uses two local commits. Each commit follows: plan, meaningful failing tests,
implementation, adversarial review, patch, re-review, checks, scope audit, then commit.

### 1. `feat(admin): make media uploads abortable`

- Add optional signal contracts without breaking existing callers.
- Propagate cancellation through every local and provider fetch plus image-dimension probing.
- Add focused client tests for every path and abort boundary.
- Expected change: 45–80 production lines and 90–140 test lines.
- Excludes queue state, dialog UI, drag events, docs, and dependency changes.

### 2. `feat(admin): add direct multi-file media uploads`

- Add the internal upload dialog and direct queue state machine.
- Integrate both page actions, the page-wide drag overlay, dialog additions, local uploads, and
  external providers.
- Add browser behavior, accessibility, RTL, responsive, cleanup, and race tests.
- Update the media-library guide and add a patch changeset for `@emdash-cms/admin`:
  **Adds direct multi-file uploads to the media library with drag-and-drop, capped parallel
  transfers, cancellation, and per-file retry.**
- Expected change: 300–420 production lines, 210–300 test lines, and 25–45 documentation lines.
- Excludes media-picker changes, server changes, percentage progress, resumable uploads, and
  dependency changes.

## Acceptance criteria

- A file drag anywhere over an upload-capable media-library view shows a blurred page overlay with a
  dashed boundary and the explicit text **Drop files to upload**.
- Page drop immediately opens the dialog and starts the queue.
- Page upload actions open an empty dialog without starting a request.
- Adding files inside the dialog immediately appends them to the running queue.
- The queue never exceeds approved concurrency and continues after individual failures.
- Every file has truthful queued, uploading, complete, or failed feedback with cancellation and
  retry actions.
- Completed-row dismissal does not delete media.
- Local and external-provider uploads reuse existing clients and server authorization.
- The feature adds no dependency or package-manager change, database or route change, or logged-out
  query.
- The complete flow works with keyboard input, Arabic RTL, reduced motion, dark mode, narrow layout,
  and 200% zoom.
- Tests can fail on premature empty-dialog opening, missing auto-start, duplicate starts,
  concurrency overflow, stale promise races, ignored aborts, wrong-provider uploads, and accidental
  media deletion.

## Approved defaults

The implementation uses these approved defaults:

1. **Concurrency:** Use three simultaneous uploads. Two reduces memory and network pressure; three
   finishes common batches sooner while keeping hashing and request work bounded.
2. **Visible-row limit:** Cap one dialog at 100 files with exact overflow feedback. Omitting a cap
   preserves today's unbounded picker behavior but permits an unbounded rendered list and queue.
3. **Active-dialog dismissal:** Prevent dismissal while queued or uploading files remain and provide
   **Cancel remaining**. Closing during active work would require either silently canceling uploads
   or a persistent background manager, both outside this PR.
