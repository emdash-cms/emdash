# Content editor publishing panel

Status: Implemented locally
Target packages: `@emdash-cms/admin` and `emdash`
Base: `origin/main` at `7a5d9c1838f6afc5649b7bc0940eacf920b40dab`
Stack position: Standalone pull request against `main`
Authority: The approving implementation request authorizes the planned code, tests, documentation, commits, and pull request. It does not authorize deployment or merge.

## Purpose

Refine the content editor's Publish section so an author can distinguish the version visitors see from unpublished draft changes, then choose whether to publish those changes immediately or schedule them.

The approved product direction is the A + C hybrid: keep publication actions together in one contextual menu and keep the Publish section readable when no action is in progress. Use Kumo components for every available control, status, overlay, and feedback pattern.

## Scope

This change includes:

- moving the primary publish and schedule choices into one contextual action menu;
- distinguishing the live version from draft changes in the Publish section;
- showing the lifecycle badge beside the Publish heading instead of after a separate Status label;
- replacing the persistent publish-date form with a view-first detail row and the shared publishing date-and-time dialog;
- replacing the inline scheduling form with the same compact date-and-time dialog pattern;
- keeping Slug, Content locale, and Publication date visible while placing Created and Updated in a collapsed Kumo disclosure;
- using local-time display and editing for publishing instants without changing stored ISO timestamps;
- preserving desktop, mobile, and distraction-free publishing access;
- saving the current editor payload before scheduling or removing a schedule;
- returning the updated revision token from schedule changes so later saves retain optimistic-concurrency protection;
- updating behavioral, end-to-end, accessibility, and visual-regression coverage; and
- adding one patch changeset for the affected packages.

This change excludes:

- API routes, authorization rules, repositories, migrations, and scheduler execution;
- changes to draft, revision, publish, unpublish, discard, schedule, or unschedule persistence semantics;
- changes to content-field `datetime` values or the shared `datetime-local.ts` contract used by field widgets;
- a general workflow or status framework for other admin pages;
- changes to Save, autosave, Preview draft, Live View, section reordering, or block-detail panels;
- locale catalog files under `packages/admin/src/locales/*/messages.po`; and
- changes to public pages or logged-out query counts.

## Verified current behavior

These facts are verified against the stated base commit.

- `ContentEditor` derives `isLive` and `hasPendingChanges` from `liveRevisionId` and `draftRevisionId`. It derives `hasSchedule` independently from `scheduledAt`.
- A published item can retain `status = "published"` while `scheduledAt` targets its pending draft. The live revision remains public until the scheduled publication promotes the draft.
- The Publish section currently renders Published, Pending changes, and Scheduled as peer badges after a Status label. The generic Schedule for later button appears below them.
- `canSchedule` is true for an unpublished item or a published item with pending changes when no schedule exists. The same Schedule for later label therefore means either first publication or a draft update.
- Editors can change `publishedAt` through an always-visible `datetime-local` input and an Update publish date button that is disabled until the value changes. The route still requires `content:publish_any`.
- Scheduling converts a browser-local `datetime-local` value with `new Date(value).toISOString()`. Its `min` value is derived from a UTC string, so the browser-local control and its minimum disagree outside UTC.
- Publish actions render in three responsive locations: the desktop settings action bar, the mobile editor header, and the distraction-free header. The settings panel stays mounted while distraction-free mode hides it.
- Schedule and unschedule routes require `content:publish_own` for owned content or `content:publish_any` for other content. A scheduled time must parse as a valid future instant.
- The repository already uses Kumo `DropdownMenu`, `Dialog`, `Popover`, `DatePicker`, `Input`, `Select`, `Button`, `Badge`, `Text`, and `Loader` patterns. `ContentList` already supplies Kumo `DatePicker` with `getDayPickerLocale()` and `getLocaleDir()`.
- The `update-live-article-safely` acceptance journey requires an author to distinguish saved draft work from the public version and keep the current article live until publication. Its status is `needs-profile`, so it supplies acceptance intent but is not currently executable as a release gate.
- `ContentEditor` saves and awaits its current payload before immediate publication. Schedule and unschedule actions need the same ordering so the two-second autosave debounce cannot leave the scheduled revision stale.

## Information architecture

The Publish section keeps identity fields first, publishing state second, and timestamps last.

```text
Publish                                      [Published]

Slug
[ autumn-opening-hours                         ]

Content locale                                    EN

┌──────────────────────────────────────────────────┐
│ ● Live version                                   │
│   Visitors still see the published version      │
│ |                                                │
│ ● Draft changes                                  │
│   Ready to publish now or schedule for later    │
│   Discard changes                                │
├──────────────────────────────────────────────────┤
│ Publication date       2 Sept 2026, 12:55  edit │
│ Created and updated                              │
└──────────────────────────────────────────────────┘
```

The action surface remains above the section:

```text
[Save] [Live View] [Preview draft] [Publish changes v]
                                      Publish changes now
                                      Schedule changes
```

### Publish heading

Place the existing `ContentStatusBadge` beside the Publish heading. Remove the separate Status label and its peer badge row.

The heading badge represents public lifecycle state:

- Draft for an item that is not live and has no schedule;
- Scheduled for an item awaiting its first publication; and
- Published for every live item, including an item with draft changes or a scheduled update.

Pending changes belong in the version relationship below the heading, not in a second heading badge.

### Version relationship

Render a compact relationship in one Kumo `LayerCard` below Slug and Content locale. The card groups version state, Publication date, and the Created and Updated disclosure without creating separate floating rows.

- A live item has a Live version row.
- A live item with pending changes adds a Draft changes row.
- A scheduled first publication has one First publication row with the scheduled instant.
- A live item with `scheduledAt` adds a scheduled Draft changes row and states that the live version remains public until then.
- A draft item has one Draft version row stating that it is not visible on the site.

Use `ContentStatusIcon` and Kumo `Text` inside ordinary semantic layout elements. Do not add trailing Live, Ready, or Scheduled labels: the row title, description, icon, and scheduled instant already communicate that state. A one-pixel `bg-kumo-line` connector may link simultaneous live and draft rows. The connector is structural and has no interaction.

Keep Discard changes adjacent to Draft changes through the existing `DiscardDraftDialog`, but render its trigger as a quiet inline ghost action below the draft description. Do not duplicate it in the publish menu.

### Date details

Render Publication date as the primary date row in the version card. Put Created and Updated in a closed-by-default Kumo `Collapsible` titled Created and updated.

- Parse every stored value with the existing `parseTimestamp()` helper, then format it with `Intl.DateTimeFormat(lingui.locale, { dateStyle: "medium", timeStyle: "short" })`. This preserves the existing UTC interpretation of timezone-less SQLite timestamps.
- Render values in `<time dateTime={storedValue}>` where a stored value exists.
- Show Publication date only when `publishedAt` exists.
- For an editor with `onPublishedAtChange`, render the Publication date value as the trigger for the shared Kumo publishing dialog and use a pencil icon as its edit affordance.
- For an author or another read-only caller, render the same value without a button or editable affordance.
- Render the Created and Updated disclosure label, labels, and values as 13-pixel secondary metadata. Align the expanded rows to the disclosure trigger's inline edges.
- Animate the disclosure panel and caret with the same 150-millisecond height and rotation transitions used by Outline and Revisions. Disable those transitions under reduced motion.
- Keep Created and Updated read-only.

Use the label Publication date. It names stored publication history and does not resemble the Publish or Schedule actions.

## Publishing states and actions

Derive one internal view state from the existing `isNew`, `isLive`, `hasPendingChanges`, `scheduledAt`, and callback availability. Do not persist a new status.

| View state                  | Condition                                  | Panel relationship                                | Action surface                                                                                                                 |
| --------------------------- | ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| New draft                   | `isNew`                                    | Draft version, not visible                        | Save only; preserve the current rule that a new unsaved item cannot publish or schedule                                        |
| Draft                       | not live, no `scheduledAt`                 | Draft version, not visible                        | Kumo menu with Publish now and Schedule publication when scheduling is available; otherwise the existing direct Publish button |
| First publication scheduled | not live, `scheduledAt` present            | First publication with local date, time, and zone | Kumo menu with Publish now, Change schedule, and Remove schedule                                                               |
| Published                   | live, no pending changes, no `scheduledAt` | Live version                                      | Preserve direct Unpublish item action; publication-date editing stays in the detail row                                        |
| Published with changes      | live, pending changes, no `scheduledAt`    | Live version plus Draft changes                   | Kumo menu with Publish changes now and Schedule changes; Discard changes remains beside Draft changes                          |
| Scheduled update            | live, `scheduledAt` present                | Live version plus scheduled Draft changes         | Kumo menu with Publish changes now, Change schedule, and Remove schedule                                                       |

If a live item has `scheduledAt` without a distinct draft revision, use Scheduled publication presentation rather than hiding the persisted schedule. Do not claim that unpublished content exists; label the second row Scheduled publication and show the stored instant.

For a collection without draft support, keep the existing raw lifecycle badge fallback and omit the two-version relationship. If `scheduledAt` exists, show one schedule summary without live/draft language. Continue to expose only actions allowed by the existing callbacks and schedule state.

### Action labels

Use labels that identify both the target and timing:

- Publish now
- Schedule publication
- Publish changes now
- Schedule changes
- Change schedule
- Remove schedule

The menu trigger is Publish for an unpublished draft, Publish changes for a live item with draft changes, Scheduled for a first-publication schedule, Scheduled update for a scheduled draft update, and Scheduled publication for a persisted schedule without a distinct draft. A caret and `aria-haspopup="menu"` communicate that these triggers open choices. The trigger omits a leading icon so its centered text and caret remain balanced in the full-width action slot.

Do not add the collection label to these menu choices. Preserve the existing collection-aware Unpublish item label for the clean published state.

Omit an action when its callback is absent. If only one action remains, render the existing direct Kumo button instead of a one-item menu. For an existing schedule, `onSchedule` enables Change schedule even though `canSchedule` is false, while `onUnschedule` independently enables Remove schedule.

## Kumo component contract

Use the current Kumo package for every matching UI primitive.

| Surface                                 | Required component                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Lifecycle badge                         | Existing `ContentStatusBadge`, backed by Kumo `Badge`                                                                |
| Publishing summary container            | `LayerCard`                                                                                                          |
| Created and Updated disclosure          | `Collapsible.Root`, `Collapsible.Trigger`, and `Collapsible.Panel`                                                   |
| Primary publishing choices              | `DropdownMenu`, `DropdownMenu.Trigger`, `DropdownMenu.Content`, and `DropdownMenu.Item`                              |
| Action triggers and confirmations       | `Button`; use its `loading` prop for new or changed publishing buttons instead of inserting a custom spinner         |
| Scheduling editor                       | One controlled, always-mounted `Dialog.Root` with `Dialog`, `Dialog.Title`, `Dialog.Description`, and `Dialog.Close` |
| Calendar                                | `DatePicker` in `mode="single"`                                                                                      |
| Time value                              | Two `Select` controls for 24-hour hour and minute values                                                             |
| Form-level validation or mutation error | Existing `DialogError` with `getMutationError()`                                                                     |
| Publication-date editor                 | The same `Dialog`, `DatePicker`, `Select`, and `Button` presentation used for scheduling                             |
| Section text                            | `Text` with semantic `as` elements                                                                                   |
| Slug and content locale                 | Existing Kumo `Input`, `Label`, `Badge`, `Tooltip`, and `Button` implementation                                      |
| Discard confirmation                    | Existing `DiscardDraftDialog`, backed by Kumo `Dialog` and `Button`                                                  |

Do not create a custom button, menu, dialog, disclosure, calendar, input, badge, tooltip, spinner, focus trap, overlay animation, or dark-mode style. Use Tailwind only for layout, the version connector, and semantic Kumo tokens. Do not refactor unchanged controls such as `PreviewButton` solely to adopt another Kumo prop.

## Schedule dialog

Render one schedule dialog at `ContentEditor` scope. The desktop settings action bar, mobile editor header, and distraction-free header open the same controlled instance. The panel shows schedule state but does not duplicate Change schedule or Remove schedule. Keep `Dialog.Root` mounted and control it through `open` and `onOpenChange` so Kumo preserves its exit animation.

The dialog contains:

- Schedule publication, Schedule changes, or Change schedule as the contextual title;
- a short description that says whether a live version remains public;
- Tomorrow at 09:00 and Next Monday at 09:00 quick choices, where Next Monday is the next strictly future Monday and advances seven days when today is Monday;
- a localized Kumo single-date picker;
- Kumo hour and minute selects;
- the browser's IANA time-zone name and selected short offset or abbreviation;
- a secondary Cancel button; and
- a primary Schedule, Schedule changes, or Save schedule button.

Use the shared compact dialog presentation for scheduling and publication-date editing. The dialog is 20rem wide at desktop sizes, remains bounded to `calc(100vw - 2rem)` and `calc(100vh - 2rem)`, scrolls internally when the viewport is short, fills the available width with the date picker, and stacks the two quick choices.

Creating a schedule starts without a selected instant. A quick choice fills both fields. Editing a schedule initializes both fields from `item.scheduledAt` in the browser's local time zone.

Schedule and publication-date controls edit minute precision. Disable Save schedule or Save date while the local date and minute still match the persisted instant. A changed value serializes with seconds and milliseconds set to zero, matching the current admin control contract.

Disable calendar days before the browser's current date. On submit, combine the selected local calendar date and time, reject a nonexistent daylight-saving time, serialize the resulting instant with `toISOString()`, and require it to be later than the current instant. The server remains authoritative and performs the same future-instant validation.

While the schedule mutation is pending:

- set the primary Kumo button's `loading` prop;
- disable the calendar, time selects, quick choices, and duplicate submission;
- let the user dismiss the dialog; and
- keep the submitted values in component state because dismissing the dialog does not cancel the request.

If no request is pending, Cancel, close, or Escape discards transient values and the next open starts from the current item. After the callback promise resolves, close the dialog if needed and reset its fields. If it rejects, keep the submitted values available when the dialog reopens and render the rejection through `DialogError` and `getMutationError()`. The existing error toast remains the global failure signal when the dialog was dismissed or the user navigated away. Clear the inline error when the user changes a field or retries.

Close and reset the dialog when the entry ID, active locale, or persisted `scheduledAt` value changes. This prevents a selection opened for one translation from being submitted after navigation to another and prevents an external schedule update from leaving stale fields open.

Capture the entry ID, locale, and a monotonically increasing submission generation when scheduling begins. A late resolve or rejection may update dialog state only when all three still match. Query invalidation remains owned by the router mutation; the stale guard prevents an operation for one entry from closing, resetting, or adding an inline error to another entry's dialog.

Use `Dialog` size `sm` with viewport-bounded padding and height so its Kumo date picker and time field fit a 320-pixel-wide or 576-pixel-tall viewport without clipping or horizontal scrolling.

## Publication-date dialog

The Publication date detail row opens the shared centered Kumo dialog for authorized editors. The trigger uses a pencil icon rather than a directional caret. The dialog reuses the localized date picker, time selects, time-zone label, local validation, compact geometry, and async-submit behavior from scheduling. It does not render quick scheduling choices.

The description states: Change the recorded date for the live version.

Use Save date for the primary action. Keep the dialog open on rejection, render the rejection through `DialogError`, and close it on success. Cancel, close, or Escape resets its draft to the persisted value. Reset its draft values when `item.id`, active locale, or `item.publishedAt` changes. Apply the same entry, locale, and submission-generation guard used by scheduling.

## Date-time contract

Add publishing-specific helpers instead of changing `lib/datetime-local.ts`.

- Parse `scheduledAt` and `publishedAt` as ISO instants.
- Use the existing `parseTimestamp()` normalization before converting persisted values to local fields or display values.
- Convert an instant into browser-local calendar and time fields.
- Convert selected local fields back to one ISO instant.
- Confirm the constructed `Date` retains the requested year, month, day, hour, and minute so a daylight-saving gap cannot normalize silently.
- Format display values with the active Lingui locale.
- Resolve the time-zone label from `Intl.DateTimeFormat().resolvedOptions().timeZone`, with a localized local-time fallback if the browser omits an IANA name.
- Recompute the displayed short zone name or offset from the selected instant so a repeated daylight-saving hour resolves to an explicit instant rather than an unlabeled wall time.

For a repeated local time during the daylight-saving fall-back transition, use the browser's earlier resolved occurrence and show its short zone name or offset before submission. Supporting selection between both repeated occurrences is outside this focused redesign.

Opening and closing an unchanged editor sends no request, including when the persisted timestamp contains non-zero seconds. A changed value uses minute precision and zero seconds. Stored types, request shapes, database columns, and scheduler comparison semantics remain unchanged. Schedule and unschedule responses add the existing optional `_rev` envelope field.

## Component and data flow

Use one small publishing-state helper because both the action surface and the panel must render the same lifecycle interpretation.

1. `ContentEditor` derives the publishing view state from the current item and existing revision booleans.
2. Every responsive `PublishActions` instance receives the same state and callbacks.
3. `PublishActions` renders either a direct single action or a Kumo dropdown when timing or schedule management creates multiple choices.
4. A schedule menu item opens the one `ContentEditor` schedule dialog.
5. The dialog converts local fields to an ISO instant and awaits `onSchedule`.
6. `ContentEditor` cancels the pending autosave and passes its current save payload when the form is dirty or an older save is still in flight. The router waits for the save queue, persists that payload when present, then calls `scheduleMutation.mutateAsync()`.
7. The schedule success handler cancels an older item refetch, merges the returned schedule state with the item from the preceding save so draft fields and hydrated bylines remain available, records the returned `_rev`, and reports Scheduled.
8. The refreshed `scheduledAt` changes the derived view state and panel relationship.
9. Remove schedule uses the same save ordering and cache update before an unpublished item returns to Draft or a live item remains Published with draft changes.
10. Publication-date submission awaits `publishedAtMutation.mutateAsync()`, then the existing update-success path refreshes the item. Existing update-error handling remains, and the popover also presents the rejection beside the submitted fields.

Broaden the exported `ContentEditorProps` callback return types from `void` to `void | Promise<void>` for `onSchedule`, `onUnschedule`, and `onPublishedAtChange`. Schedule and unschedule callbacks also receive the current editor save payload. Existing synchronous callers remain valid. Add `isUnscheduling?: boolean`; continue to use the existing `isScheduling` and `isUpdatingPublishedAt` props. The router passes each mutation's pending state to the matching Kumo control.

Each responsive `PublishActions` instance owns its Kumo menu state and reports `onMenuOpenChange` to `ContentEditor`. Only one action surface is interactive at a time. `ContentEditor` uses that report together with the shared schedule-dialog state to give an open Kumo overlay first handling of Escape.

Do not add a context provider or generalized workflow state machine.

## Authorization and privacy

The UI remains a capability hint, not an authorization boundary.

- Show schedule actions only when the existing lifecycle conditions and scheduling callbacks permit them.
- Keep owner-aware publish and schedule enforcement in the existing routes.
- Keep publication-date editing restricted to editor-level UI and `content:publish_any` server authorization.
- Do not expose a hidden publication-date trigger, caret, editable label, or dialog to unauthorized users.
- Do not add content, user, or time-zone data to logs or analytics.

No direct-access route changes are required.

## Failure, concurrency, and interruption

- Validate missing, past, and daylight-saving-gap values before calling the API.
- Cancel the pending autosave and wait for the editor save queue before schedule or unschedule. Persist the current payload when the form is dirty or an older save is still in flight, and do not send the schedule change when that save fails.
- Advance the editor's opaque revision token from successful schedule and unschedule responses before another save can begin.
- Treat server rejection as authoritative. Do not reset the editor; preserve the submitted fields whether the overlay is open or closed. The toast reports the failure globally, and `DialogError` keeps correction context beside the fields when the editor still belongs to the active entry.
- Disable repeated schedule, update-date, and unschedule submissions while their mutation is pending.
- Allow an in-flight schedule dialog to close without claiming that the request was cancelled; reset its draft only after success.
- Close a dropdown item before opening the schedule dialog so focus moves through one overlay at a time.
- Return focus to the connected action that opened the schedule dialog. Use Kumo's default restoration when it identifies that action; retain the originating button ref only if the component browser test proves a programmatic open needs the fallback.
- Track whether the publishing menu or schedule dialog is open. The distraction-free Escape handler must return without exiting distraction-free mode while either Kumo overlay owns Escape; the overlay closes first.
- Reset local editor state on entry or locale change to prevent stale-item submission.
- Ignore local state updates from a schedule or publication-date promise that settles for an earlier entry, locale, or submission generation.
- Preserve the existing route, repository, scheduled-worker, toast, and atomic publication behavior.
- Do not add client retries. A user can retry after the existing mutation error is visible.
- Do not add a concurrency token to schedule requests. Return the existing editor `_rev` token after a schedule change.

## Compatibility and cost

- No database migration or content backfill is required.
- Schedule and unschedule responses add the existing optional `_rev` envelope field. Request shapes do not change.
- No new package dependency.
- No new query, scheduled-worker operation, or logged-out round trip.
- Existing synchronous `ContentEditor` callback implementations remain assignable to the broadened callback types.
- Existing plugin panels, sortable sections, preview behavior, and public component exports remain available.
- Do not include extracted `messages.po` files. The locale workflow will extract the new source messages after merge.
- Add one patch changeset for `@emdash-cms/admin` and `emdash` describing the clearer live-versus-draft state, contextual publish scheduling, local-time publication display, and schedule revision-token response. State that stored timestamps do not change.

## Accessibility, localization, and visual contract

- Put every user-facing string, aria label, date phrase, validation message, and toast change through Lingui.
- Pass `getDayPickerLocale(lingui.locale)` and `getLocaleDir(lingui.locale)` to Kumo `DatePicker`.
- Use logical Tailwind properties. Flip directional carets in right-to-left layouts when Kumo does not do so itself.
- Keep normal content and controls at Kumo's 14-pixel content size. Use 13 pixels for the secondary Created and Updated metadata. Use semibold headings and medium emphasis; do not add letter tracking.
- Use only semantic Kumo color, line, surface, and text tokens. Do not add raw colors or `dark:` classes.
- Let `DropdownMenu`, `Dialog`, and `Collapsible` own focus, keyboard navigation, overlay position, motion, and reduced-motion behavior.
- Keep menu and dialog actions available without hover.
- Preserve the action bar's flexible wrapping at a 320-pixel mobile viewport and settings widths from 320 through 480 pixels.
- Keep long translated menu labels and date values wrapping without horizontal scrolling or clipped controls.
- Verify English, Arabic, and the pseudo locale. Arabic must preserve reading order, connector placement, popup alignment, and date-picker direction.
- Capture before-and-after pull-request screenshots with descriptive alt text for published-with-changes in English and Arabic.

## Test plan

Tests must assert user behavior, not Tailwind classes or Kumo internals.

### Date-time unit tests

- An ISO instant displays as the correct local calendar date and minute. A zero-second instant round-trips identically.
- A persisted instant with non-zero seconds remains unchanged when the editor is opened and closed without a field edit; a changed minute serializes with zero seconds and milliseconds.
- Local date and time serialize with the browser offset rather than a sliced UTC minimum.
- Missing date, missing time, a past instant, and a daylight-saving gap produce actionable validation errors.
- A repeated fall-back time resolves to the earlier occurrence and displays that occurrence's short zone name or offset.
- Tomorrow and next-Monday quick choices remain future values around day, month, and year boundaries.
- Display formatting follows the active locale and the time-zone fallback remains usable.

### Component browser tests

- Draft, first-publication scheduled, published, published-with-changes, and update-scheduled items render the state matrix in this specification.
- Published with changes exposes Live version and Draft changes simultaneously. It does not show Status or Schedule for later.
- The Publish changes menu contains Publish changes now and Schedule changes. Each choice uses one compact 14-pixel row with a 16-pixel action icon and a smaller info icon. A native Kumo tooltip provides the supporting description.
- A scheduled item exposes Publish now, Change schedule, and Remove schedule through one Kumo menu without duplicate panel actions.
- Missing callbacks remove their actions, and a single remaining action renders as a direct Kumo button rather than a one-item menu.
- Clean published content retains the direct Unpublish item action.
- The version relationship and date details share one Kumo `LayerCard`; it omits redundant trailing state words and keeps Discard changes as a quiet inline draft action.
- Publication date stays visible, while Created and Updated start collapsed behind the Kumo Created and updated disclosure.
- Publication date is view-first, opens the shared centered dialog for editors, stays read-only for authors, and submits the expected ISO instant.
- The schedule dialog opens from desktop, mobile, and distraction-free action surfaces while only one dialog exists.
- A rejected async callback preserves its values for correction or retry. A resolved callback closes and resets the editor. Pending state prevents duplicate submission, and dismissing a pending dialog does not cancel or duplicate the request.
- Entry and locale changes close the editors and clear stale transient values.
- A late resolve or rejection from the previous entry does not close, reset, or add an error to the current entry's editor.
- A live item with `scheduledAt` but no distinct draft labels its second row Scheduled publication instead of claiming draft changes.
- A collection without draft support keeps its raw lifecycle presentation and still exposes a persisted schedule.
- Escape closes idle Kumo overlays in the expected order. A nested overlay does not close the mobile settings sheet.
- Existing Save, Preview draft, Live View, section reordering, block-sidebar, and distraction-free behavior remains reachable.

### Router and end-to-end tests

- Router callbacks return the schedule, unschedule, and publication-date mutation promises while preserving current toasts. Schedule changes cancel older item refetches and merge their returned state into the cache. Schedule and publication-date rejected promises also render inline when their editor still belongs to the active entry.
- Scheduling and removing a schedule save a dirty editor payload first, cancel the pending debounce, and use the returned revision token for the next save.
- Clean schedule changes create no draft revision when no save is active. If an older save is active, persist the current value after it before changing the schedule.
- Update the schedule end-to-end flow to open the Kumo publish menu and dialog, select a future local time, observe the POST response, and see the scheduled relationship.
- Add a published-with-changes flow that schedules updates through the UI, confirms the existing public version remains readable before the scheduled instant, then removes the schedule and confirms the item remains published with draft changes.
- Keep the existing publish, unpublish, permission, and API tests green.
- Update the content-editor English and Arabic visual snapshots in the pinned visual runner.
- Run the existing content-editor accessibility check without new Web Content Accessibility Guidelines violations.
- Manually exercise the goal and observations in `update-live-article-safely` against the existing end-to-end fixture. The formal journey remains non-blocking until its `editorial-team` profile and Author session exist; this pull request must not add that unrelated fixture.

## Expected files and line bounds

Expected production files:

- `packages/admin/src/components/ContentSettingsPanel.tsx`
- `packages/admin/src/components/ContentEditor.tsx`
- `packages/admin/src/components/PublishingDateTimeEditor.tsx`, containing the shared fields and schedule dialog
- `packages/admin/src/lib/content-publishing-state.ts`
- `packages/admin/src/lib/publishing-datetime.ts`
- `packages/admin/src/lib/api/content.ts`
- `packages/admin/src/router.tsx`
- `packages/core/src/api/handlers/content.ts`

Expected test and release files:

- `packages/admin/tests/components/ContentSettingsPanel.test.tsx`
- `packages/admin/tests/components/ContentEditor.test.tsx`
- `packages/admin/tests/components/PublishingDateTimeEditor.test.tsx`
- `packages/admin/tests/lib/content-publishing-state.test.ts`
- `packages/admin/tests/lib/publishing-datetime.test.ts`
- `packages/admin/tests/router.test.tsx`
- `packages/admin/tests/lib/content-rev.test.ts`
- `packages/admin/tests/publish-autosave-race.test.tsx`
- `packages/core/tests/unit/api/content-handlers.test.ts`
- `e2e/tests/content-actions.spec.ts`
- `e2e/tests/accessibility.spec.ts`
- `e2e/tests/visual-regression.spec.ts`
- existing content-editor visual snapshots
- one patch changeset for `@emdash-cms/admin`

The expected implementation is 450–620 changed production lines, 500–760 changed test lines, and 5–12 changeset lines. The implementation approval removes line-count and file-count stop thresholds; use these estimates only to prompt a scope review. Stop when code does not map to this specification, not because an in-scope implementation exceeds an estimate. Adding a custom interactive primitive remains out of scope.

Count production additions and deletions. Binary snapshot changes do not count toward the line threshold. Line bounds are review gates, not targets.

## Commit sequence

Implementation uses the following rhythm for every commit:

`plan → meaningful failing tests → implementation → adversarial review → patch → re-review → checks → scope audit → local commit → next commit`

### Commit 1: `fix(admin): make publishing times local and explicit`

Responsibility:

- add publishing-specific instant/local-field helpers;
- add the always-mounted Kumo schedule dialog with quick choices and local validation;
- open it from the existing scheduling trigger before moving that trigger; and
- make router schedule callbacks awaitable so success resets the dialog and failure preserves its values.

Acceptance:

- the existing scheduling capability uses Kumo `Dialog`, `DatePicker`, `Select`, and `Button`;
- local fields serialize to the intended ISO instant outside UTC;
- invalid or past local values do not call `onSchedule`; and
- success closes the dialog while rejection preserves its values.

Expected size: 170–240 production lines and 170–250 test lines.

Exclusions: no publish dropdown, no status-layout change, no publication-date disclosure change.

### Commit 2: `refine(admin): group publish and schedule actions`

Responsibility:

- add the focused publishing-state derivation;
- enhance `PublishActions` with Kumo `DropdownMenu` only when multiple timing or schedule actions exist;
- thread the same schedule-management callbacks through desktop, mobile, and distraction-free surfaces; and
- remove the generic Schedule for later trigger and duplicate schedule actions from the panel.

Acceptance:

- each lifecycle state exposes only the actions in the state matrix;
- published draft actions group immediate and scheduled publication choices;
- scheduled items can publish immediately, change the schedule, or remove it; and
- clean published items retain the direct collection-aware Unpublish action.

Expected size: 150–220 production lines and 160–240 test lines.

Dependency: Commit 1 supplies the shared schedule dialog.

Exclusions: no version relationship, date detail redesign, visual snapshots, or changeset.

### Commit 3: `refine(admin): distinguish live and draft versions`

Responsibility:

- move the lifecycle badge into the Publish heading;
- add the live/draft relationship and adjacent discard action;
- replace the persistent publish-date form with a view-first Kumo publication-date editor;
- render the date details with localized semantic time values;
- update focused end-to-end, accessibility, and English/Arabic visual proof; and
- add the patch changeset.

Acceptance:

- the Publish section matches the information architecture and visual contract in this specification;
- authorized and read-only publication-date states are distinct;
- all five persisted lifecycle scenarios remain legible at supported widths and in Arabic; and
- the live article remains public while an update is drafted or scheduled.

Expected size: 130–190 production lines, 190–270 test lines, and 5–12 changeset lines.

Dependency: Commits 1 and 2 supply the shared date-time and action contracts.

Exclusions: no core, database, scheduler, public-site, or general editor refactor.

### Commit 4: `refine(admin): frame publishing state and dates`

Responsibility:

- place the version relationship and date metadata in one Kumo `LayerCard`;
- remove redundant trailing state words from version rows;
- make Discard changes a quiet inline draft action; and
- keep Publication date visible while moving Created and Updated into a Kumo disclosure.

Acceptance:

- the summary has one rounded visual boundary with balanced inline padding;
- Live version and Draft changes retain their relationship without a separate Live or Ready label;
- scheduled descriptions include the scheduled instant in text; and
- Created and Updated remain keyboard-accessible without competing with Publication date.

### Commit 5: `refine(admin): clarify publishing actions`

Responsibility:

- rename published-draft actions around changes rather than updates;
- simplify scheduled trigger labels;
- remove the leading icon from the full-width menu trigger; and
- use compact one-line menu items with 16-pixel action icons and Kumo info tooltips for the descriptions.

Acceptance:

- Publish changes opens Publish changes now and Schedule changes;
- Scheduled update opens Publish changes now, Change schedule, and Remove schedule;
- each description remains available through its Kumo info tooltip; and
- the action wording matches the dialog it opens.

### Commit 6: `refine(admin): unify publishing date dialogs`

Responsibility:

- replace the publication-date popover with the shared centered dialog pattern;
- share the dialog header, fields, errors, and footer between scheduling and publication-date editing;
- constrain both dialogs to a 20rem desktop width, a viewport-safe height, and a full-width Kumo date picker; and
- stack scheduling shortcuts to remove unused horizontal space.

Acceptance:

- both date editors open in the same location with the same interaction model;
- the schedule dialog and publication-date dialog fit a 320-pixel-wide or 576-pixel-tall viewport without clipping or horizontal scrolling;
- Cancel and Escape restore focus to the originating control; and
- existing validation, async errors, stale-entry guards, and ISO serialization remain unchanged.

### Commit 7: `fix(admin): preserve editor state across schedule changes`

Responsibility:

- serialize the current editor save before scheduling or removing a schedule;
- cancel the pending autosave while either schedule change is in flight;
- return the updated `_rev` from schedule and unschedule handlers; and
- keep the admin revision token synchronized without a follow-up read.

Acceptance:

- edits made immediately before a schedule change are included in the saved draft;
- clean schedule changes do not create a draft revision unless a corrective save must follow an older in-flight value;
- a failed save prevents the schedule change;
- schedule and unschedule responses expose the current revision token; and
- schedule cache updates retain the draft fields and hydrated bylines from the preceding save; and
- the next manual save or autosave does not fail with a stale revision conflict.

## Review and verification gates

At implementation start, verify the recorded base against the current `origin/main`. If the tip advanced, inspect the intervening diff and revalidate the ContentEditor, Kumo, and acceptance-journey contracts before editing.

After each implementation edit, run `pnpm lint:quick`. After each commit-sized round, run the affected admin browser tests and root `pnpm typecheck`.

Before completion, run:

- focused admin component, helper, and router tests;
- `pnpm exec playwright test e2e/tests/content-actions.spec.ts`;
- the content-editor accessibility test;
- the English and Arabic content-editor visual-regression cases in the pinned runner;
- `pnpm format`;
- `pnpm typecheck`;
- `pnpm --silent lint:json | jq '.diagnostics | length'` and require `0`;
- `pnpm changeset status`;
- `pnpm --dir docs build`; and
- `git diff --check`.

The pull request diff must contain no locale catalogs, API routes, request-shape changes, database changes, unrelated editor cleanup, raw color utilities, physical-direction Tailwind classes, or hand-built Kumo equivalents. The only response-contract change is the additive existing `_rev` field for schedule and unschedule. Include before-and-after interface screenshots with useful alt text.

## Acceptance criteria

The feature is ready for approval when all of the following are true:

1. An author can identify the live version and draft changes without interpreting multiple peer status badges.
2. Publish and schedule choices use one contextual Kumo menu with labels that identify first publication versus updates.
3. Scheduling an update states and preserves that the current version remains live.
4. Every schedule can be inspected, edited, removed, or published immediately without duplicate actions.
5. Publication date is readable by everyone who can view the editor and editable only by an authorized editor.
6. Publishing date and time fields display in the browser's local zone, serialize to unchanged ISO instant contracts, reject past and nonexistent local times, and identify the active zone.
7. Save, autosave, Preview draft, Live View, Discard changes, Publish, Unpublish, scheduled publishing, and responsive action access retain their existing behavior.
8. Kumo supplies every available interactive and display primitive; custom code provides only feature state, data conversion, and structural layout.
9. English, Arabic, pseudo-localized, keyboard-only, reduced-motion, 320-pixel mobile, and 320–480-pixel sidebar checks pass without clipping or lost actions.
10. The change adds no public query, database work, API request change, migration, dependency, or logged-out cost. Schedule and unschedule add only the existing optional `_rev` response field.
11. Tests, typecheck, lint, formatting, visual proof, accessibility checks, and the patch changeset pass the stated gates.

## Decisions approved with this specification

Approving this specification also approves these implementation choices:

- Use a single Kumo `Dialog` for scheduling instead of reproducing the mockup's anchored scheduling popover. Scheduling can start from three responsive action surfaces, and one dialog preserves input, focus, and pending state without duplicated overlay implementations.
- Use the same compact centered Kumo `Dialog` pattern for Publication date and scheduling so both date-editing interactions behave predictably.
- Display and edit `scheduledAt` and `publishedAt` as local instants with an explicit browser time-zone label while preserving their stored ISO values.
- Include Tomorrow at 09:00 and Next Monday at 09:00 as localized, vertically stacked quick choices.
- Group version state and date metadata in one Kumo `LayerCard`, with Created and Updated behind a Kumo disclosure.
- Keep Discard changes beside Draft changes as a quiet inline action outside the publish menu.
- Keep the clean-published Unpublish item action direct because it has no competing timing choice.

No unresolved product decision blocks implementation after these choices are approved.
