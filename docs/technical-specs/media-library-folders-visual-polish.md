# Media Library folder visual polish

Status: Approved for local implementation by the current thread
Dependency: `feat/media-folders-ui` commit `c2d451f5`, stacked on `feat/media-folders-api` commit `b5b28210`
Intended position: focused follow-up commits on PR2 before it is pushed or opened
Reference: Strapi Upload stable Media Library at `e8b156d3a629`; exclude `src/future`

## Authority

This document defines a visual-polish follow-up to the implemented flat-folder feature. It does not
authorize source edits, commits, pushes, pull requests, merges, releases, or deployments by itself.
The current `$feat-implement` invocation separately authorizes the local source changes and commits
listed here. It does not authorize GitHub mutation.

The folder-specific maintainer Discussion gate recorded in the PR2 specification still applies to a
ready-for-review pull request.

## Purpose

Bring the implemented Media Library folder UI to the compact, predictable baseline of Strapi's
stable Media Library while retaining EmDash's Kumo components, flat-folder model, bounded queries,
safe deletion, and explicit link semantics.

After this follow-up:

- folder cards read as lightweight navigation rows rather than stacked content cards;
- root actions, media cards, and folder dialogs have deliberate narrow-screen geometry;
- Back and breadcrumbs use consistent navigation semantics and typography;
- folder names remain identifiable across long strings and mixed LTR/RTL content;
- list view integrates folder state into the table instead of leaving a detached folder surface; and
- every commit has reproducible interaction checks plus reviewed screenshots before the next commit
  begins.

## Scope

### Included

- Compact horizontal folder cards using Kumo `LayerCard`, a router-aware link, and a separate edit
  button.
- Strapi-style 4/3/2/1 folder progression using the existing responsive grid.
- Router-link Back behavior and compact, single-scale Kumo breadcrumbs.
- Direction-aware rendering for user-provided folder names.
- Equal mobile root action widths and concise local upload wording.
- Deliberate mobile create/edit footer stacking.
- Media cards filling sparse one-column mobile tracks without changing desktop column calculation.
- List-view folder loading, error, load-more, navigation, and edit controls within the mixed table.
- Behavioral and geometry checks at desktop, mobile, LTR, RTL, dark, and light states.

### Excluded

- Folder counts, asset counts, subtitles, nesting, parent selection, folder moves, bulk selection,
  bulk actions, drag and drop, or upload placement.
- Changes to media queries, folder queries, permissions, routes, schemas, storage, usage, or database
  state.
- Changes to Media Picker, Portable Text, providers, CLI, MCP, plugins, or imports.
- Reworking numbered pagination, search semantics, Location data flow, upload queue behavior, or
  Media Details layout.
- Strapi's row-click-only navigation, recursive folder deletion, unbounded folder fetch, eagerly
  loaded Location tree, or mixed-direction omissions.
- General shell, sidebar, typography, media hover animation, or unrelated table redesign.
- Committed image snapshots before maintainers accept environment-specific visual baselines.

## Verified current state

### Branch and runtime

The authoritative implementation is `/private/tmp/emdash-media-folders-ui` at `c2d451f5`. The
browser audit ran an isolated fixture on port 4554. The server process cwd and the rendered footer
both resolved to this worktree and commit after rebuilding ignored package artifacts.

The audit created two folders and 40 local images, then exercised:

- page sizes and numbered page 1 to page 2 with a forced 1.2-second response delay;
- grid and list views;
- global filename/folder search;
- folder open, Back, browser history, rename, safe delete, and media return to Main library;
- Media Details with closed and open Location controls;
- create, edit, and delete confirmation dialogs;
- 1512×982 and 320×800 viewports;
- dark, light, English LTR, and Arabic RTL rendering.

No page error or horizontal document overflow occurred. Search/filter and media-card gaps both
resolve to 12px. At 1512px the media grid resolves to seven 161.7px tracks and the folder grid to
four 292px tracks. Pending numbered pagination retains the previous grid and paginator bounding
boxes while making the grid inert.

### Confirmed visual gaps

1. Folder cards are two-tier 126px cards. Strapi's stable card is one compact horizontal row.
2. At 320px, **Add new folder** fills 274px while **Upload to Library** stays approximately 161px.
3. A 272px one-column mobile media track contains a 200px card, leaving 72px unused.
4. The edit-folder footer wraps as Cancel on one row and Delete/Save on another by accident.
5. Back is a button even though it changes the URL; the breadcrumb root/current items use different
   type scales.
6. Long Latin folder names under Arabic truncate from the identifying prefix because the text
   inherits RTL direction.
7. List view renders a detached **Folders** heading and load-more surface above a table whose folder
   rows already appear first; the edit button floats at the far edge of the wide Filename cell.

### Behavior that already passes

- Folder names are real links with a separate labeled edit button.
- Opening a search-result folder clears search.
- Root, named-folder, global search, MIME filters, and bounded folder pages map to the approved API
  behavior.
- Pending numbered pagination keeps its rendered geometry and does not reset document scroll.
- Create, rename, safe delete, and single-media Location updates persist.
- Deleting a folder preserves the media URL and returns the item to Main library.
- Dialog focus, save races, stale-folder recovery, permissions, and provider boundaries are covered
  by the existing PR2 tests.

## Strapi baseline to retain

Stable Strapi provides the reference hierarchy, not a component-by-component copy.

### Header

- Back precedes the title only inside a folder.
- The title stays **Media Library** and breadcrumbs sit below it.
- Add-folder and add-assets actions form one group with an 8px gap and equal full widths when
  stacked.
- The page header moves actions below the title on narrow screens.

Source: `packages/core/upload/admin/src/pages/App/components/Header.tsx:54-112` and
`packages/core/admin/admin/src/components/Layouts/HeaderLayout.tsx:128-210` in Strapi.

### Folder card and grid

- One horizontal card row contains the icon, linked name/body, and trailing edit action.
- The card uses compact padding and a single surface.
- The grid progresses 4/3/2/1 columns and cards stretch to their tracks.
- Folders precede media; a quiet divider separates the two groups.

Source: Strapi `FolderCard.tsx:30-115`, `FolderGridList.tsx:10-22`, and stable
`MediaLibrary.tsx:385-499`.

### List and dialog

- List view is one mixed table with folders first and explicit navigation/edit actions.
- Create/edit is one dialog. Cancel leads; Delete and Save remain one related group.
- Enter submits from the name field.

Source: Strapi `TableList/TableRows.tsx:45-149` and `EditFolderDialog.tsx:183-329`.

## Deliberate EmDash differences

- Do not add Strapi's count subtitle; the flat API intentionally has no count query.
- Keep the edit button visible enough for touch. Pointer hover may increase emphasis, but it must not
  be the only way to discover the action.
- Keep explicit folder-name link semantics. Do not make the entire card or table row an unlabeled
  click target.
- Keep **Back to Main library** in the empty-folder call to action. Use concise **Back** only for the
  header navigation link.
- Keep root-only uploads and use **Upload Files** for the local provider. External-provider upload
  labels remain provider-specific.
- Keep bounded **Load more folders**, safe-delete copy, lazy Location search, logical Tailwind
  classes, and mirrored directional icons.
- Improve on Strapi by applying `dir="auto"` to user folder names.

## Visual and interaction contract

### Compact folder cards

Render each grid folder as one Kumo `LayerCard` surface containing one row:

1. A router-aware link occupies the icon and name region and grows to available width.
2. The folder icon remains in the existing 40px semantic Kumo tint chip.
3. The folder name is semibold, single-line, truncated, and `dir="auto"`.
4. A separate Kumo square ghost edit button trails the link.

The card has one border/ring, one radius, 12px internal padding, and 12px between primary groups.
The edit icon can use lower resting opacity on hover-capable pointers but remains visible on touch
and when the card contains focus. No custom motion is added.

Use the existing grid gap. Change the final four-column threshold from `xl` to `lg`; keep the
standard `sm` and `md` breakpoints. At 1512×982 and a collapsed or expanded sidebar, four cards fit.
At 320×800, cards use one full-width track.

### Header and breadcrumbs

- Remove the existing top-level Back button and render `RouterLinkButton` before the title inside the
  folder header. Its route search removes only `search.folder`; preserve the filename search, MIME
  filter, provider, view mode, and page size. Reset only the asset page and retained total. Keep
  `resetScroll: false`. Intercept only an unmodified primary click to run the existing focus/page
  reset callback; preserve modified-click and context-menu link behavior.
- Label the header link **Back**. Retain the mirrored arrow.
- Use Kumo `Breadcrumbs size="sm"` and a 14px router-aware root crumb so root and current folder share
  one optical scale and line height.
- Wrap the current folder name in `dir="auto"`.

### Narrow root actions and media cards

- Root header actions stack in one full-width column below `sm`.
- Both action buttons fill that column and share height, radius, and leading/trailing edges.
- The local primary action reads **Upload Files**. External-provider wording is unchanged.
- Local media cards fill the available grid track below `sm`. Existing desktop auto-fill tracks,
  seven-column MacBook layout, aspect ratio, provider cards, and 200px cap remain unchanged.

### Folder dialog footer

Remove the nonessential create/edit description paragraph. Kumo `Dialog.Title`, Name, and the action
labels provide the complete task context.

Below `sm`, render actions as a deliberate full-width vertical stack in DOM order:

1. Cancel
2. Delete folder when editing
3. Save or Create

At `sm` and above, preserve Strapi's hierarchy: Cancel at the start, Delete and Save/Create grouped
at the end with an 8px gap. Pending states disable every conflicting action. Confirmation dialog
copy and focus behavior do not change.

### Mixed-direction names

Apply `dir="auto"` to the text node that renders a user folder name in:

- grid cards;
- list rows;
- current breadcrumb;
- Location selected value; and
- Location options; and
- read-only Location text for users without move permission.

Layout direction remains inherited from the admin locale. Only the user-provided string chooses its
own inline direction. Accessible labels retain the complete folder name.

### List view

List mode remains one table with folder rows before media.

- Do not render a standalone **Folders** heading or divider above the table.
- Once the media table shell exists, order list folder states as: a full-span folder loader or
  error/retry row; loaded folder rows; a full-span post-row load-more error/retry when a later page
  fails; then the full-span **Load more folders** row while another cursor remains. Existing media
  rows follow these folder rows and states. The existing whole-media initial loader remains unchanged
  while the media request itself has no renderable items.
- Keep the folder name link and edit button in the Filename cell, but group them with `justify-start`
  and a compact gap so the edit action does not float hundreds of pixels away.
- Preserve the current five-column media table and accessible em-dash context. Do not add a general
  media actions column in this follow-up.

## Responsive state matrix

Every implementation commit must be checked at these states before review:

| Viewport/state | Required evidence |
| --- | --- |
| 1512×982 root grid, dark and light | Header grouping, at least four fixture folders proving four tracks, seven media tracks, 12px gaps, no overflow |
| 1512×982 root list | One mixed table, folder-first order, aligned edit action, no detached folder surface |
| 1512×982 named folder | Back/link/breadcrumb hierarchy, sparse media, paginator alignment |
| 320×800 root grid | Equal full-width actions, full-track cards, reachable toolbar/paginator |
| 320×800 create/edit/delete | Deliberate action stack, visible Name/error, no clipped buttons |
| 320×800 Media Details/Location | Existing reachable control and popup geometry remain unchanged |
| 320×800 Arabic root/folder | Logical ordering, mirrored Back/pagination, prefix-preserving Latin folder names |
| Delayed page 1 → 2 request | Before/pending grid and paginator boxes change by at most 1px; content is inert |

Screenshots are generated into a temporary audit directory for human review after each commit. Do
not commit environment-specific baselines in this sequence. Geometry assertions and interaction
tests are committed and determine pass/fail; screenshots are supplementary evidence.

## Test plan

### Component behavior

- Folder cards expose one link whose accessible name contains the complete folder name and one edit
  button.
- The Back control has link semantics and invokes the reset/focus callback only for unmodified
  primary activation.
- Mobile action and dialog behavior is tested through rendered geometry, not Tailwind class-string
  assertions.
- Grid/list/current/Location name surfaces preserve the full accessible name and carry `dir="auto"`.
- List mode does not render the grid-only Folders heading; folder loading, retry, and load-more remain
  reachable in the table.
- Existing folder permission, empty, error, focus, and mutation tests remain green.

### Browser interaction and geometry

Extend the existing Media Library Playwright flow with a bounded reusable fixture:

- create at least four folders and enough unique media to produce a second numbered page;
- verify action widths differ by at most 1px at 320px;
- verify the local media-card width equals its one-column grid track within 1px at 320px;
- verify each mobile folder-dialog action occupies its own row, shares the available inner width
  within 1px, and preserves Cancel → Delete → Save tab order;
- verify folder row positions prove one column at 639px, two at 640px, three at 768px, and four at
  1024px; repeat just below each transition at 767px and 1023px;
- verify root grid/list, named folder, folder search, create/edit/delete, and Location closed/open;
- verify rename and safe delete preserve the media URL;
- verify browser Back/Forward, direct folder URL, focus restoration, and search clearing;
- separately enter a folder, set filename search and MIME filter, activate the header **Back** link,
  and assert the root URL, preserved filename/MIME/page-size/provider/view state, asset page reset,
  preserved scroll position clamped only when the destination has a smaller maximum scroll, and
  Media Library heading focus;
- retain a separate search-result-folder assertion proving folder navigation clears filename search;
- delay page 2 and compare before/pending geometry;
- repeat the folder/name surfaces under Arabic and assert document width equals viewport width;
- for an overflowing Latin folder name under Arabic, assert computed `direction: ltr`,
  `scrollWidth > clientWidth`, and the complete accessible name retains the identifying prefix;
- verify the read-only Location value uses the same automatic direction for a non-owner local item.

Use behavioral assertions for committed tests. Use screenshot inspection as a per-commit gate rather
than accepting snapshots automatically.

## Expected files and line budget

Expected production files:

- `packages/admin/src/components/MediaLibrary.tsx`
- `packages/admin/src/components/MediaFolderDialog.tsx`
- `packages/admin/src/components/MediaDetailPanel.tsx`

Expected tests:

- `packages/admin/tests/components/MediaLibrary.test.tsx`
- `packages/admin/tests/components/MediaFolderDialog.test.tsx`
- `packages/admin/tests/components/MediaDetailPanel.test.tsx`
- `e2e/tests/media-library.spec.ts`
- `e2e/tests/accessibility.spec.ts` for the changed populated list table and its post-media-shell
  folder loader/error/retry rows

Expected documentation:

- this technical specification only;
- no public guide, changeset, locale catalog, lockfile, query-count snapshot, or visual baseline.

Projected totals:

| Area | Production lines | Test lines | Spec lines |
| --- | ---: | ---: | ---: |
| Compact cards, Back, breadcrumbs, bidi | 40–80 | 50–100 | 0 |
| Responsive actions, cards, dialog footer | 20–45 | 40–90 | 0 |
| List composition and bounded states | 30–65 | 50–100 | 0 |
| Technical specification | 0 | 0 | 390–470 |
| Total | 90–190 | 140–290 | 390–470 |

Treat 190 production lines as a warning threshold. Stop for scope review above 230. Block above 280
production lines or if the work adds counts, nesting, bulk actions, drag/drop, upload placement,
provider behavior, picker behavior, new API contracts, or a general table/navigation framework.

## Implementation sequence

Every commit follows:

`plan → failing behavior test → implementation → browser geometry/screenshots → Terra X-High review → patch → re-review → checks → scope audit → local commit`

Do not start the next commit until the current commit's interaction flow and screenshots meet its
acceptance criteria.

### Commit 1: Match compact folder navigation hierarchy

Responsibility: Replace stacked folder cards with compact horizontal folder navigation, use real
Back-link semantics, align breadcrumb typography, advance the four-column threshold, and make folder
names direction-aware.

Acceptance criteria:

- Grid cards are one horizontal Kumo surface with one icon/name link and one edit button.
- The existing top Back button is removed. Back is a router-aware link before the title, labeled
  **Back**; it removes only the folder route state, preserves search/filter/provider/view/page-size
  state, resets the asset page, retains `resetScroll: false`, and keeps modified clicks native.
- Breadcrumb root/current items share the compact 14px scale.
- Folder names preserve their prefix in Arabic for long Latin values.
- Four folder columns render at `lg`; one full-width folder card renders at 320px.
- Existing navigation, focus, search clearing, permission, and mutation behavior is unchanged.

Expected size: 40–80 production lines and 50–100 test lines.

Explicit exclusions: header action sizing, media-card sizing, dialog footer, list loading/load-more,
counts, selection, and folder data flow.

### Commit 2: Balance narrow-screen actions and sparse media

Responsibility: Make local header actions, sparse media cards, and folder-dialog actions deliberate at
small widths.

Acceptance criteria:

- Local Add/Upload actions share width and edges below `sm`; desktop hierarchy remains secondary then
  primary.
- Local label is **Upload Files**; external providers retain their names.
- Local cards fill one-column tracks at 320px and retain desktop grid math. Provider cards are
  unchanged.
- Create/edit actions form a full-width mobile stack and the existing desktop footer grouping.
- Create/edit/delete dialogs remain keyboard accessible, focus-safe, and untranslated strings remain
  routed through Lingui.

Expected size: 20–45 production lines and 40–90 test lines.

Explicit exclusions: folder-card anatomy, pagination, Media Details layout, upload behavior, and
provider contracts.

### Commit 3: Integrate folder states into list view

Responsibility: Remove the detached grid-only folder surface from list mode and put bounded folder
states where the folder rows render.

Acceptance criteria:

- One table renders folder rows before media with no standalone Folders heading.
- Folder edit stays adjacent to the folder link.
- After media is renderable, folder loading, retry, and explicit Load more remain accessible
  full-span rows. The existing whole-media initial loader is unchanged.
- A failed later folder page renders retry after existing folder rows and before Load more.
- Grid mode retains its heading, loader/error, load-more, divider, and media ordering.
- Browser coverage delays or fails the folder request after media has rendered, proving the table
  loader/error row. A later-page failure proves post-row retry ordering.
- The accessibility audit covers populated list mode plus post-media-shell folder loading and
  later-page failure rows.
- No folder query, cursor, permission, provider, or pagination behavior changes.

Expected size: 30–65 production lines and 50–100 test lines.

Explicit exclusions: new columns, general table abstractions, whole-row clicks, media-row actions,
bulk behavior, and API changes.

## Final acceptance criteria

The follow-up is complete when all three commits are locally committed, independently reviewed, and
the final branch satisfies the responsive state matrix without material visual or interaction
findings.

The final tree must retain:

- flat folders and safe delete;
- bounded folder queries;
- root-only local uploads;
- provider and picker compatibility;
- stable numbered pagination and focus;
- Kumo controls, Lingui strings, logical RTL classes, and keyboard navigation; and
- a clean worktree with no pushed branch or GitHub mutation.
