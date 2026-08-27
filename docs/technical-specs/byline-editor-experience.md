# Byline editor experience

Status: Proposed
Base: `origin/main` at `5c7995f4`
Stack position: standalone PR on `main`
Authority: design only; this document does not authorize implementation, commits, pushes, or GitHub changes

## Summary

Replace the content editor's dense byline form with one focused workflow:

1. Show the public credit currently attached to the entry.
2. Let an editor search for or create a byline.
3. Show explicitly selected credits in their public order.
4. Use the drag handle for ordering and keep role, profile editing, and removal in each credit's action menu.

The implementation stays inside `@emdash-cms/admin`. It reuses the current content and byline APIs, locale rules, autosave behavior, Kumo components, and `@dnd-kit`. It does not change stored data, server routes, public rendering, the Bylines management page, or logged-out query counts.

## User model

A byline is a reusable public identity. The content owner is the internal EmDash user responsible for the entry.

When an entry has no explicit credits, EmDash may infer one byline from the owner. The content API identifies that credit with `source: "inferred"`. Selecting any explicit byline suppresses the owner fallback for that entry. Explicit credits have a saved order and may have a role label that applies only to that entry.

The editor must distinguish these cases:

- **Automatic credit:** one owner-derived byline, shown as read-only context.
- **Explicit credits:** one or more bylines selected by an editor.
- **No visible credit:** no explicit credit and no owner-linked byline at the entry's locale.
- **Unresolved locale credit:** `primaryBylineId` is present but no byline resolves at the entry's locale. The UI must not claim that the owner fallback will render.

## Goals

- Make the common action, choosing an existing byline, visible and understandable.
- Explain the owner-derived fallback before an explicit selection replaces it.
- Keep selected credits easy to scan, reorder, label, edit, and remove at every supported panel width.
- Use public Kumo components for every interactive control.
- Preserve current autosave, localization, locale-pinned search, permissions, and API behavior.
- Fix quick-create slug generation so it follows the typed name until the slug is manually edited.
- Keep search, creation, mutation errors, and focus recovery inside the workflow that produced them.

## Non-goals

- Do not change `_emdash_bylines`, `_emdash_content_bylines`, content tables, migrations, or API schemas.
- Do not change author-to-byline inference, explicit-credit precedence, locale hydration, or public site rendering.
- Do not redesign the Bylines management page or Byline schema page.
- Do not add profile fields, avatar rendering, bulk selection, a new permission, or a new dependency.
- Do not add a custom avatar, combobox, menu, dialog, button, input, surface, typography scale, or animation.
- Do not change the overall content editor, settings-panel ordering, panel resizing, publishing controls, or other settings sections.
- Do not update Lingui catalogs in the feature PR.

## Verified current behavior

- `ContentSettingsPanel.tsx` contains a private `BylineCreditsEditor` with search, selected-credit controls, quick-create, and quick-edit dialogs.
- Search is locale-pinned, debounced by 300 ms, and capped at 20 server results. The parent already supplies up to 100 initial bylines for the entry locale.
- Selected credits are resolved from the saved entry and the current search result, so credits outside the initial page remain visible.
- `ContentEditor` includes bylines in save and autosave payloads only after the editor changes them. New entries always include their selected bylines.
- `bylineCreditSchema` already exposes `source?: "explicit" | "inferred"`, but the admin `ContentItem` type omits it. `ContentEditor` therefore places inferred credits in editable explicit-credit state.
- An inferred credit can reappear after an editor attempts to remove it because clearing explicit credits restores the owner fallback.
- The quick-create name handler stops generating the slug after the first typed character. Browser and Vitest reproduction both produce `r` after typing `Review Tester` one character at a time.
- The quick-edit mutation changes a reusable byline's display name and slug. Those changes affect every entry that renders that byline.
- The editor settings panel is 320–480 px wide on desktop and a 320 px sheet below the `lg` breakpoint.
- Kumo 2.6.0 provides the required `Autocomplete`, `Button`, `Collapsible`, `Dialog`, `DropdownMenu`, `Input`, `Loader`, and `Text` APIs. It does not expose a styled Avatar component.

## Component boundary

Extract the byline UI into an internal `BylineCreditsEditor.tsx`. `ContentSettingsPanel` continues to own the section heading and passes data and callbacks. The new component owns only presentation state, search state, create/edit dialog state, and selected-credit ordering.

Keep the exported `ContentEditorProps` contract compatible. Preserve `onQuickCreateByline` and `onQuickEditByline`; do not rename or remove them. Add `source?: "explicit" | "inferred"` to the admin content-credit type as an optional additive field.

`ContentEditor` must split `item.bylines` before initializing form state:

- `source === "inferred"` becomes read-only `inferredByline` context.
- `source === "explicit"` or missing `source` becomes editable explicit-credit state. Treating a missing source as explicit preserves compatibility with older responses.
- Dirty-state serialization, save payloads, and autosave payloads contain explicit credits only.
- If a malformed response contains inferred and explicit credits together, explicit credits control the visible state and payload. Never write the inferred ID.

When the last explicit credit is removed, save `bylines: []`. After a successful save and refetch, the server decides whether an inferred credit appears. The client must not synthesize one.

Key the extracted component by collection, entry ID or new-entry identity, and entry locale. Switching entries or translations resets chooser text, dialogs, role drafts, drag state, and locally remembered search results. A late create or edit result from an unmounted instance may leave the reusable profile on the server, but it must not update the next entry.

## Interaction states

### Automatic credit

Show the section heading `Bylines` and description `People shown publicly on this post.`

Render the inferred byline's display name with:

- secondary text `From the post owner`;
- a Kumo `Badge` labelled `Automatic`;
- supporting copy `Choosing a byline replaces this automatic credit.`;
- one Kumo secondary button labelled `Choose bylines`.

Do not expose role, reorder, edit, or remove controls for an inferred credit.

### No credit

Show `No byline is shown on this post.` and the same `Choose bylines` action. Do not claim that an owner fallback exists unless the server returned an inferred credit.

If explicit credits exist at another locale but do not resolve at the active locale, retain the current locale-specific guidance and link to the Bylines page. The state must not fall back to another locale or to the owner.

### Choose a byline

`Choose bylines` and the selected-state add button open a Kumo popover anchored to the trigger. Keep the credit list mounted behind the popover so opening search does not resize or scroll the settings sections.

Use one controlled Kumo `Autocomplete`:

- visually hidden label: `Search bylines`;
- placeholder: `Search by name…`;
- `size="base"`;
- all available matching items in one scroll-capped `Autocomplete.List`;
- no fixed five-item slice;
- each option shows the display name and a muted slug only when it helps distinguish similar names;
- selected bylines are omitted from results;
- Escape closes the chooser and restores focus to its trigger.

Use the parent-provided list while the query is empty. For a non-empty query, keep the existing 300 ms debounce and request `fetchBylines({ search, locale, limit: 20 })`. Keep previous results while the next query is pending. React Query's locale-and-search key remains the stale-response boundary.

Show one create option for a non-empty query when `onQuickCreateByline` exists and neither the normalized display name nor generated slug exactly matches an available result. Show it only after the latest search succeeds; hide it while that search is pending or failed because the client cannot rule out a duplicate. Duplicate names that require a different identity remain a full Bylines-page task.

Search states:

- **Loading with no results:** show an inline Kumo `Loader` and `Searching…`.
- **Loading with previous results:** retain the results and show a non-blocking loader.
- **No match:** show `No matching bylines.` followed by the create option.
- **Error:** preserve the query, show `Couldn’t search bylines.`, and provide a Kumo `Retry` button.
- **More results:** show `Keep typing to narrow the list.` when `nextCursor` exists. Do not add pagination to the editor.

Selecting an option adds it at the end once, closes the chooser, clears its query, marks bylines as touched, and returns focus to the new credit row.

### Explicit credits

Show `Bylines` with an instant help tooltip containing `Shown to readers in this order.` Place the add action and section drag handle on the heading row, then render the credits as a compact stack of Kumo `LayerCard` rows immediately below it. Do not render a persistent description row.

Each row contains:

1. a Kumo square ghost drag handle at the logical start;
2. the display name;
3. the role label as secondary text when set;
4. a Kumo square ghost `DropdownMenu` trigger at the logical end.

Use `@dnd-kit` pointer, touch, and keyboard sensors to reorder rows. The nested byline `DndContext` must not move the outer settings section. Mark the activator with the existing `data-sortable-handle` and `data-sorting` attributes so `MobileSidebarPortalGuard` preserves the mobile sheet during blur and Escape. The handle is the only ordering control; the action menu does not duplicate it with Move up or Move down commands.

The row menu contains:

- `Set role` or `Edit role`;
- `Edit name and slug` when `onQuickEditByline` exists; the edit dialog states that the change applies everywhere;
- a separator;
- `Remove from post` with `variant="danger"`.

Removing a credit updates only the entry's explicit-credit list. It never calls `deleteByline`.

### Role label

Selecting the role action opens a Kumo `Collapsible` region directly below that row. Use a base-size Kumo `Input` labelled `Role on this post (optional)` and a secondary `Done` button. Keep a local draft while the editor is open. Done commits the draft to the credit; Escape discards the draft, closes the region, and restores focus to the row menu trigger.

The role label remains optional free text. This PR does not change how sites choose to render it.

### Create byline

Keep one controlled Kumo `Dialog.Root` mounted. Open it from the chooser's create option.

The dialog contains:

- title `Create byline`;
- description `Create a reusable public profile, then add it to this post.`;
- one base-size `Input` labelled `Name`;
- a Kumo `Collapsible` labelled `Advanced` containing a base-size `Input` labelled `URL slug` and description `Generated automatically.`;
- Cancel and primary `Create and add` buttons.

Generate the slug from the complete typed name until the user edits the slug. Use a small byline-specific helper that produces a value accepted by the server's `/^[a-z][a-z0-9-]*$/` contract. It must remove Latin diacritics, collapse separators, start with a letter, cap the result at 80 characters, and use a stable `byline-<hash>` fallback when the name has no ASCII letters. Do not add a transliteration dependency.

Keep `Create and add` enabled until submission. Empty or invalid fields use Kumo `Input.error`; focus the first invalid field. During the request, keep the label visible, set the button loading state, and prevent duplicate submission. On API failure, keep the dialog and values open and show `DialogError`. Cancel returns focus to the chooser input because the create option lives in a closed popup. On success, add the returned byline exactly once, close the dialog, clear the chooser, and focus the new credit row.

If profile creation succeeds but the later content autosave fails, keep the created profile. The editor retains the unsaved explicit credit and the existing autosave error toast. A retry must not create another profile.

### Edit reusable name and slug

Keep one controlled edit dialog mounted because `onQuickEditByline` is part of the exported editor contract. Reuse the create-dialog field order, advanced slug disclosure, validation, and error handling.

The dialog description must state `Changes apply everywhere this byline appears.` A successful update refreshes cached byline lists and the selected row. A failure leaves the dialog open.

## Visual contract

### Kumo components

Use the installed public components directly:

- `Autocomplete` for search and result selection;
- `Button` for all actions and drag handles;
- `DropdownMenu` for row actions;
- `Popover` for the anchored chooser;
- `Dialog` for create and reusable-profile edit;
- `Collapsible` for Advanced and the per-entry role editor;
- `Input` for name, slug, and role;
- `Loader` for search and mutation feedback;
- `Text` and `Badge` for labels and state.

Use Phosphor icons through Kumo icon or trigger props. Do not add raw interactive elements, local lookalikes, a second provider, or a custom avatar.

### Typography

- Inherit the existing Kumo typeface. Do not set a font family or smoothing locally.
- Render the section heading with the existing `Text bold as="h3"` pattern.
- Use `Text bold` for display names and `Text variant="secondary"` for descriptions, slugs, roles, and helper copy.
- Let Kumo controls own their internal typography.
- Do not add `text-xs`, one-off pixel sizes, `font-bold`, `tracking-*`, uppercase copy, or custom line heights.
- Keep all headings and actions in sentence case.
- Allow names and translated copy to wrap. Use `min-w-0` and `wrap-break-word` for long unbroken values; do not truncate a name unless the full value remains available.

### Spacing, alignment, and surfaces

- Reuse the section's `p-4` inline edges. All headings, descriptions, lists, inputs, and buttons align to that shared track.
- Keep the heading, ordering-help trigger, add action, and section drag handle on one visual row.
- Use a smaller gap inside a heading-description group than between the group and its action or list.
- Use one compact stack of separate Kumo `LayerCard` rows. Do not nest cards or add custom borders or shadows.
- Keep Kumo's radii, shadows, focus rings, disabled states, hover states, and press feedback. Do not override component internals.
- Place the drag handle at inline start and row actions at inline end with logical classes only.
- Keep destructive color only on `Remove from post`. Do not use color as its only meaning.

### Motion and appearance

- Kumo owns chooser, menu, dialog, and disclosure motion.
- Keep dialogs mounted and control their `open` state.
- Do not add page-load animation, color transitions, `transition: all`, custom shadows, raw colors, or `dark:` classes.
- Use semantic Kumo tokens for the noninteractive list dividers and layout text.
- Verify light and dark modes without component-level overrides.

## Responsive behavior

The same information order and actions apply at every width. The component reflows inside its container rather than reading viewport breakpoints.

- Desktop settings-panel widths: 320, 368, and 480 px.
- Mobile settings sheet: 320 px at supported narrow viewports.
- Rows keep the handle, name, and action trigger reachable without horizontal scrolling. Long names and roles wrap inside the middle column.
- Autocomplete content, dropdown menus, and dialogs stay inside the viewport and above the mobile settings sheet.
- The create dialog uses Kumo `size="sm"`; its actions wrap or stack without changing their order.
- Use base-size Kumo inputs without a page-local font-size override and never block browser zoom. If iOS verification exposes a package-wide Kumo input-zoom problem, record it as a design-system gap instead of expanding this PR.

Manual verification must cover 320, 360, 480, 768, 1023, 1024, and 1440 px viewports plus 200% browser zoom. These samples validate continuous reflow and the existing mobile breakpoint; they are not CSS targets.

## Accessibility, localization, and RTL

- Every icon-only button has a localized accessible name. Decorative icons use `aria-hidden="true"`.
- Kumo Autocomplete owns combobox, listbox, arrow-key, Enter, and Escape behavior.
- Kumo Dialog owns focus trapping. Opening a dialog focuses Name; a validation failure focuses the first invalid input. The controlled workflow restores focus to a stable chooser input, row menu trigger, or newly added row when the originating popup item no longer exists.
- The drag handle supports pointer, touch, and DnD Kit's keyboard model, including live instructions and position announcements.
- Status changes such as adding, moving, or removing a credit use one polite live region. Validation and mutation failures use field errors or `DialogError`, not color or toast alone.
- All visible copy, placeholders, accessible names, error text, and live-region text use Lingui.
- Use logical Tailwind utilities. Verify Arabic with the panel on the left, correct row order, logical menu placement, and no directional icon errors.
- Verify pseudo-localized labels, long names, long roles, and long unbroken slugs at the minimum width.
- Do not include extracted `messages.po` changes in the feature PR.

## Permissions and privacy

Keep the existing editor-level section gate and existing server authorization. This feature does not add routes, permission strings, or direct-access behavior. It exposes no data that the current byline list and content responses do not already return.

## Cost and bounds

- Add no logged-out query or round trip.
- Add no initial admin query. The closed chooser uses the parent-provided list.
- Run a server query only for a non-empty debounced search, as today.
- Keep the server result limit at 20 and render results in one bounded scroll area.
- Keep selected-credit operations local until the existing content save or autosave.
- Add no dependency and no reusable abstraction outside the byline editor.

## Test plan

### Content-state boundaries

- An inferred credit renders as Automatic and never enters save or autosave payloads.
- A missing `source` remains an explicit credit for backward compatibility.
- Selecting an explicit credit while an inferred credit is visible saves only the explicit ID.
- Removing the last explicit credit saves `[]`; the refetched server response decides whether Automatic reappears.
- `primaryBylineId` with no current-locale hydrated credit never shows an owner fallback.
- A malformed mixed-source response renders and saves only its explicit credits.
- New entries keep their current byline save behavior.

### Search and selection

- Typing calls the locale-pinned API after the debounce and keeps the input focused.
- Keyboard selection adds one credit and returns focus to the new row.
- A selected byline is absent from results; repeated activation cannot duplicate it.
- Exact matches suppress the quick-create option; pending and failed searches suppress it until a successful result can rule out a duplicate.
- Missing quick-create and quick-edit callbacks hide only their corresponding actions.
- A credited byline outside the initial list still renders from the entry response.

### Create and edit

- Typing `Review Tester` one character at a time produces `review-tester`; a manually edited slug stops following the name.
- Diacritics, punctuation, leading digits, empty strings, and names with no ASCII letters produce a valid result or a localized field error.
- Advanced is closed by default and preserves a manually edited slug.
- Empty submission focuses Name. API errors preserve values and keep the dialog open.
- Create success adds once. Edit success refreshes the selected row. Closing either dialog restores focus to its trigger.
- Switching entries or locales while a chooser or dialog is open clears its local state; a late result cannot modify the next entry.

### Selected credits

- Pointer, touch, and keyboard reorder change serialized order without moving the outer settings section.
- The row menu contains no duplicate ordering actions; the drag handle remains keyboard operable.
- Role editing updates only that credit's `roleLabel`.
- Remove credit changes the content payload and never calls the byline-delete API.
- Long translated actions wrap without overlap at 320 px.

### Browser verification

- Complete choose, create, role, reorder, edit, remove, cancel, error, and retry flows with keyboard only.
- Verify accessible names, focus restoration, live announcements, and dialog errors.
- Verify the listed viewport widths, 200% zoom, light/dark modes, Arabic RTL, and pseudo-localization.
- Confirm there is no horizontal page or settings-panel overflow and no console error.

Do not add tests that assert Tailwind classes, Kumo DOM internals, or mocked callback arguments without a user-visible behavior. Each regression test must fail when the corresponding workflow breaks.

## Expected files

| File                                                           | Change                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/admin/src/components/BylineCreditsEditor.tsx`        | New internal Kumo workflow and byline-specific slug helper                        |
| `packages/admin/src/components/ContentSettingsPanel.tsx`       | Replace the private editor with the extracted component                           |
| `packages/admin/src/components/ContentEditor.tsx`              | Separate inferred context from editable explicit credits; preserve exported props |
| `packages/admin/src/lib/api/content.ts`                        | Add optional credit `source` to the admin type                                    |
| `packages/admin/tests/components/BylineCreditsEditor.test.tsx` | Focused workflow, error, keyboard, and boundary tests                             |
| `packages/admin/tests/components/ContentEditor.test.tsx`       | Inferred/explicit payload and integration regressions                             |
| `.changeset/<generated-name>.md`                               | Patch note for the clearer byline workflow                                        |

No other production file is expected. A change outside this list requires a scope review before implementation continues.

## Commit plan

Implementation uses this rhythm for each commit:

`plan → meaningful failing tests → implementation → adversarial review → patch → re-review → checks → scope audit → local commit`

### Commit 1: distinguish automatic and explicit credits

Responsibility:

- Add the optional admin credit source type.
- Keep inferred credits out of editable form, dirty, save, and autosave state.
- Pass inferred context to the byline section.
- Add behavioral regressions for fallback, explicit replacement, legacy missing-source responses, and locale-empty state.

Expected change: 40–90 production lines and 90–160 test lines.

Exclusions: no visual redesign, API change, migration, query, or changeset.

### Commit 2: replace the byline section with the approved Kumo workflow

Responsibility:

- Extract `BylineCreditsEditor`.
- Implement chooser, create/edit dialogs, role disclosure, accessible ordering, scoped removal, all UI states, and the byline slug helper.
- Remove the previous private component from `ContentSettingsPanel`.
- Add focused component tests and the admin patch changeset.

Expected change: 350–550 production lines added with 300–380 lines removed from `ContentSettingsPanel`, 250–420 test lines, and one changeset sentence.

Exclusions: no manager-page redesign, core change, new dependency, avatar UI, or unrelated settings cleanup.

### Commit 3: keep search and ordering spatially stable

Responsibility:

- Render search in a native Kumo popover without replacing or moving the selected-credit list.
- Keep ordering on the pointer, touch, and keyboard drag handle instead of duplicating it in the row menu.
- Add focused regressions for the stable chooser and simplified menu.

Exclusions: no data-flow change, new dependency, custom overlay, or settings-panel redesign.

## Scope gates

- **Expected:** the seven files above, three commits, no public API removal, no server or database work.
- **Warning:** more than five production files, more than 650 added production lines before deletions, or a new local UI abstraction. Stop for a scope audit.
- **Blocking:** any core/API/schema/migration change, new dependency, Bylines-page redesign, additional logged-out query, custom design-system component, or exported breaking change. Obtain explicit approval before proceeding.

Line ranges are review gates, not implementation targets.

## Acceptance criteria

- An editor can identify whether a credit is automatic or explicitly selected without understanding the data model.
- An editor can find, add, create, order, label, edit, and remove explicit credits from one section.
- Every operation states whether it affects this post or the reusable byline profile.
- Inferred credits never leak into explicit save payloads.
- Search remains locale-pinned, debounced, bounded, and free of duplicate selections.
- The workflow uses native Kumo components, Kumo typography, semantic tokens, logical layout classes, and Phosphor icons only.
- The workflow remains readable and operable from 320 px through the maximum settings-panel width, at 200% zoom, in light and dark modes, and in Arabic RTL.
- Loading, empty, no-match, validation, API-error, retry, disabled, and success states keep user input and focus in the relevant workflow.
- No database, server contract, public renderer, permission, full Bylines page, or logged-out query changes.
- The focused tests, admin typecheck, formatting, `pnpm lint:quick`, and `pnpm lint:json | jq '.diagnostics | length'` pass.

## Product decisions

The approved interaction fixes the product decisions for this PR:

- automatic owner credit is read-only context;
- explicit credits replace the fallback;
- quick create asks for Name first and hides Slug under Advanced;
- global name/slug editing stays available but explicitly warns that changes apply everywhere;
- role labels remain optional and entry-specific;
- ordering uses one drag handle with pointer, touch, and keyboard support;
- duplicate-name edge cases remain a full Bylines-page task;
- avatars are excluded because the installed Kumo package has no public styled Avatar and adding media work would expand scope.

No unresolved product decision blocks implementation.

## Authorization statement

This specification authorizes no implementation, Git commit, branch mutation, push, pull request, rebase, merge, or GitHub change. Start implementation only after explicit approval through a later `$feat-implement` request.
