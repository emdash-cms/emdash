# Content Editor Sidebar Redesign

Redesign the content editor (`packages/admin/src/components/ContentEditor.tsx`) from
"two rounded cards in a scrolling page" to a structural 3-pane layout:
**nav | editor | settings panel** — inspired by Notion CMS and the Loops.so editor.

## Design decisions (agreed)

- **Actions live in the panel** (Loops style): a sticky action bar at the top of the
  settings panel holds Save / Publish / Preview / autosave status / Discard. The
  editor column becomes pure content.
- **Panel is structural, not a card**: full height, flat `bg-kumo-base`, single
  straight edge, no rounding, fixed width (~320px), independent
  `overflow-y-auto` scroll region — implemented as a Kumo `Sidebar`
  (`variant="sidebar"`, `defaultWidth`), not a hand-rolled div (see Structural
  constraints).
- **Flat sections with hierarchy**: one scroll; hairline dividers; Publish gets
  visual prominence; section labels drop to small/muted (weight + color hierarchy,
  not a stack of identical bold `h3`s); Move to Trash isolated at the very bottom.
- **Below `lg`**: panel becomes a slide-over sheet from the end side via Kumo
  `Sidebar`'s `mobileBreakpoint`, opened by a Settings button; a Save button +
  autosave indicator stay visible outside the sheet.
- **Shell change**: the editor route opts out of the Shell's `p-6` main padding to
  go full-bleed (the only structural touch outside the editor components).

## Rules that constrain every commit

- Logical Tailwind only (`border-s`, `ms-*`, `start-*`) — the reference sample's
  `fixed right-0 border-l ml-1` is exactly what we must NOT do.
- Kumo tokens + components only; no raw grays, no `dark:` prefixes, no hand-rolled
  buttons.
- All new strings through Lingui; don't commit `messages.po` churn.
- Test in Arabic (RTL) before calling any commit done.
- `pnpm lint:quick` + `pnpm typecheck` per commit; existing admin tests keep passing.
- Preserve existing behaviors: distraction-free mode, block sidebar panels
  (`ImageDetailPanel` replaces settings sections), autosave, scheduling, i18n badge.

## Structural constraints (from adversarial review)

- **The `<form>` wraps both panes.** The editor is a single
  `<form onSubmit={handleSubmit}>`; the panel contains `type="submit"` buttons and
  inputs whose Enter-to-submit must keep working. In the 3-pane layout the form
  element itself becomes the full-height flex row containing the editor column and
  the panel — the panel is never a DOM sibling outside the form.
- **Portaled controls need explicit form wiring.** Kumo `Sidebar`'s mobile sheet
  mode (and any Dialog) renders via portal, which breaks native form association.
  The form gets a stable `id`; any submit button rendered inside the sheet uses
  the `form="<id>"` attribute (inputs in the sheet likewise get `form="<id>"`
  where Enter-to-submit matters). Kumo `Button`'s pass-through of the `form`
  attribute is an assumption — verify it in the DOM before relying on it
  (commit 6).
- **The sidebar has eight sections, not six**: Publish, Ownership, Bylines,
  Translations, **Taxonomies** (`TaxonomySidebar`), SEO, **Document Outline**
  (`DocumentOutline`), Revisions. Document Outline consumes `portableTextEditor`
  state owned by `ContentEditor` (set via a callback threaded into
  `FieldRenderer`) — `ContentSettingsPanel` receives it as a prop.
- **The panel is a Kumo `Sidebar`, not a hand-rolled div.** Kumo `Dialog` has no
  sheet/side-drawer variant, and hand-styling one violates "never duplicate
  component styles". Kumo `Sidebar` natively provides the desktop rail
  (`defaultWidth`, `collapsible="offcanvas"`) AND the mobile sheet
  (`mobileBreakpoint` ≈ the `lg` pixel value) in one component.
- **Kumo `Sidebar`'s `side` prop is physical.** The Shell nav already flips
  manually (`getLocaleDir(locale) === "rtl" ? "right" : "left"`, `Shell.tsx:41`);
  the settings panel uses the exact inverse:
  `getLocaleDir(locale) === "rtl" ? "left" : "right"`. Blanket "logical classes
  only" does not cover this prop — it must be flipped explicitly.
- **Nested `Sidebar.Provider` is unverified.** The Shell wraps the app in a
  `Sidebar.Provider` for the nav; the settings panel needs its own Provider scope.
  Prove in commit 3 (likely via the `contained` prop) that the inner Provider
  doesn't clobber the outer's collapse state or keyboard shortcuts — before
  building anything on top of it.
- **Memoization happens at extraction time.** `formData` lives in `ContentEditor`,
  so every keystroke re-renders the whole tree. Commit 2 creates the memo seam:
  `React.memo(ContentSettingsPanel)` with `useCallback`-stable handler props,
  written while the props list is being authored — not retrofitted later. The
  sticky action bar (commit 4) renders as a separate child so high-frequency
  props (`isDirty`, `isSaving`, `isAutosaving`) don't bust the panel body's memo.
  Stability must hold at BOTH layers: `ContentEditPage`/`ContentNewPage` in
  `router.tsx` create ~15 handler props as inline arrows
  (`onPublish={() => publishMutation.mutate()}`, `handleSave`, …) that are
  recreated on every mutation-state flip — twice per autosave cycle — and flow
  straight into the panel (`onAuthorChange`, `onSeoChange`, `onTranslate`).
  Wrap them in `useCallback` in commit 2 (React Query mutation objects are
  stable references; the arrows are the only instability).
- **"The editor route" is two routes.** `contentEditRoute`
  (`/content/$collection/$id`) and `contentNewRoute` (`/content/$collection/new`)
  both render `ContentEditor`. Full-bleed opt-in, the 3-pane layout, and every
  verify step apply to both — otherwise creating a post renders the old padded
  layout and snaps into the new shell on first save.

## Commits

### 1. `refactor(admin): allow routes to opt out of Shell main padding`

- `Shell.tsx`: support a full-bleed mode for the `<main>` region (route-level
  signal, e.g. TanStack Router `staticData` or a context flag). Default stays
  `p-6 overflow-y-auto`; full-bleed routes get `p-0 overflow-hidden` so children
  manage their own scroll.
- The signal must be attachable to BOTH editor routes (`contentEditRoute` and
  `contentNewRoute` in `router.tsx`) — see Structural constraints.
- No visual change to any existing route yet.
- Verify: dashboard/content list/media unchanged; editor route unchanged (not yet
  opted in).

### 2. `refactor(admin): extract ContentSettingsPanel from ContentEditor`

- Mechanical extraction: move the sidebar card — all **eight** sections (Publish,
  Ownership, Bylines, Translations, Taxonomies, SEO, Document Outline, Revisions)
  plus the block-panel swap logic — out of the 2,146-line `ContentEditor.tsx` into
  `ContentSettingsPanel.tsx`.
- Cross-pane dependencies threaded as props: `portableTextEditor` (for
  DocumentOutline), taxonomy props (`collection`, `entryId`, `entryLocale`), slug
  value + `handleSlugChange`, scheduler state, byline state, translations query.
- Zero visual/behavioral change. Props in, callbacks out. The panel stays inside
  the `<form>`.
- `React.memo(ContentSettingsPanel)` from day one, with every handler prop made
  `useCallback`-stable as it's threaded — the memo seam is authored here, not
  retrofitted. This includes the `router.tsx` layer: wrap the inline handler
  arrows in `ContentEditPage`/`ContentNewPage` in `useCallback` (see Structural
  constraints).
- Verify: editor renders identically for a collection with taxonomies + portable
  text (all eight sections present); tests pass; the panel body does not
  re-render while typing in a field, and re-renders **at most once** per autosave
  cycle — on the legitimate `item` data update (new `updatedAt`), NOT on the
  `isPending` flips (React DevTools profiler or a render counter — the
  isPending case is the one that catches unstable router-level arrows).

### 3. `feat(admin): structural 3-pane editor layout (desktop)`

- BOTH editor routes (`/content/$collection/$id` AND `/content/$collection/new`)
  opt into full-bleed. The `<form>` element becomes the full-height flex row (see
  Structural constraints); layout becomes:
  - editor column: `flex-1 overflow-y-auto`, fields centered with a comfortable
    `max-w`, slim back/title/locale-badge strip at top (the locale `Badge` from
    the current header, `ContentEditor.tsx:632`, moves here — it's the only
    indicator of which translation is being edited).
  - settings panel: Kumo `Sidebar` (`contained`, `defaultWidth: 320`,
    `collapsible="none"` for now), full height, own scroll, still inside the form.
    Physical `side` flipped for RTL: `getLocaleDir(locale) === "rtl" ? "left" : "right"`.
- **Prove nested `Sidebar.Provider` first**: inner Provider (settings) must not
  clobber the outer (nav) — collapse both, exercise keyboard shortcuts, check
  mobile detection. While proving the integration, also confirm that
  `mobileBreakpoint` sheet mode works with the chosen `collapsible` value —
  commit 6 depends on toggling the sheet via open state, and Kumo's docs don't
  document the interaction with `collapsible="none"`. If nesting fails, fall
  back to a plain flex pane for desktop and revisit commit 6's sheet strategy
  before proceeding.
- Card chrome removed from the fields container: fields sit directly on the page
  (Notion style) in a centered `max-w-3xl` column. Fine-tune after seeing it live.
- Panel width starts at 320px (`defaultWidth`); tune against real content (bylines
  search, revision list) during review.
- Below `lg`: temporarily keep today's stacking (sheet comes in commit 6).
- Distraction-free mode: unchanged behavior (panel hidden, editor centered).
- Verify visually against the running dev server, LTR + RTL (nav and panel on
  opposite sides in Arabic), AND the `/new` flow — create a post and confirm no
  layout jump on first save.

### 4. `feat(admin): sticky action bar in settings panel`

- Move Save / Publish / Preview / autosave indicator / Discard-draft into a sticky
  two-tier top inside the panel:
  - tier 1: autosave status (start) + primary action cluster (end).
  - tier 2: status context — Published / Pending changes / Draft / Scheduled, plus
    Unschedule/Discard where relevant.
- The action bar is its own child component, a sibling of the memoized panel body —
  high-frequency props (`isDirty`, `isSaving`, `isAutosaving`) flow only into the
  bar, so keystrokes never bust the panel body's memo (see Structural constraints).
- Remove the **normal-mode** header action cluster and the bottom-of-form duplicate
  SaveButton hack (`ContentEditor.tsx:805-812`) — the sticky bar makes both
  redundant.
- **Distraction-free mode keeps its hover-revealed overlay** with exit button,
  SaveButton, and autosave indicator — the panel is hidden in that mode, so the
  overlay is the only save/exit surface. Do not delete it with the normal-mode
  cluster.
- Keyboard/submit behavior: the form's submit path and Enter-to-submit keep
  working; action bar buttons are the same `type="submit"`/handlers as before
  (panel is inside the form on desktop, so no `form=` attribute needed yet).
- Verify: save, publish, schedule, unpublish, discard, autosave indicator — in
  normal mode AND distraction-free mode.

### 5. `feat(admin): settings panel visual hierarchy pass`

- Section headings: small, muted, consistent casing (weight/color hierarchy —
  no more identical bold headings). Headings rendered inside child components
  (TranslationsPanel, TaxonomySidebar, DocumentOutline, RevisionHistory) get the
  same treatment so the panel reads as one system.
- Publish section: most visual weight, at top under the action bar.
- Hairline dividers between sections; consistent spacing rhythm (`p-4`/`space-y-3`).
- Move to Trash: isolated at the very bottom of the panel, visually separated.
- Inputs stay Kumo; no bespoke styling.
- Verify in both themes + pseudo-locale (`EMDASH_PSEUDO_LOCALE=1`) + Arabic.

### 6. `feat(admin): settings sheet below lg breakpoint`

- Switch the panel's Kumo `Sidebar` to `mobileBreakpoint` = the `lg` pixel value:
  below it, Kumo renders the panel as a mobile dialog sheet automatically. A
  Settings button in the editor's slim top strip toggles it (via the Sidebar's
  open state — no separate Dialog wiring).
- **This commit owns the `collapsible`/open-state configuration.** Commit 3 ships
  `collapsible="none"` for a static desktop rail; if the sheet toggle is inert
  under it (see commit 3's verification gate), change to `collapsible="offcanvas"`
  below the breakpoint or a controlled `open` prop — whichever the commit-3
  findings showed actually works. Desktop behavior must not regress: the rail
  stays permanently visible at `lg` and above.
- ~~The mobile sheet mode is a portal → `form=` wiring~~ **RESOLVED during
  implementation: Kumo's mobile sheet renders inline in the DOM (verified in
  source and at runtime), so native form association holds with zero wiring.
  Save-from-sheet verified end to end (dirty → submit → server round-trip).**
- **Keep a Save button + autosave indicator in the slim top strip below `lg`** so
  saving doesn't require opening the sheet and autosave feedback stays visible —
  today's header shows both on every viewport; don't regress that.
- Nested dialogs: Move to Trash and Discard-changes confirms open _from inside_
  the sheet (modal-in-modal). **DEVIATION (found during implementation): Kumo's
  mobile sheet dismisses itself on focusout when focus moves to a portaled Base
  UI dialog. Rather than fight library internals, the accepted behavior is
  "modal supersedes sheet" — opening a dialog from the sheet may close the sheet
  underneath; the dialog then handles Escape/scrim on its own. Dialog
  open/confirm/cancel state transitions verified headless; the animation-level
  interplay (Escape ordering, focus return) needs a MANUAL QA pass in a real
  visible browser — headless preview throttles rAF and CSS transitions, which
  Base UI's transitions depend on.**
- **Block sidebar panels must open the sheet.** Below `lg`, when a portable-text
  block requests sidebar space (`blockSidebarPanel` set → `ImageDetailPanel`
  replaces panel content), the sheet auto-opens; closing the block panel restores
  the settings content and returns the sheet to its prior open/closed state.
  (Implemented as `MobileBlockSidebarSync`; needs MANUAL QA with a real image
  block — inserting one requires the media picker dialog, which can't run in the
  headless preview.)
  Without this, tapping "edit image details" on a tablet renders the controls
  into a closed drawer and nothing visibly happens. (Today's stacked layout has
  the same hole — the behavior is defined here, not inherited.) Verify this flow
  explicitly in this commit, not commit 7.
- Verify at mobile/tablet/desktop widths, LTR + RTL.

### 7. `chore(admin): polish, tests, changeset`

- Edge cases: translations panel navigation; new-item vs edit flows;
  collections without drafts/SEO/revisions/taxonomies/portable-text (sections hide
  cleanly, including Document Outline when no portableText editor is mounted).
  (Block-panel-in-sheet behavior is verified in commit 6 where it's built —
  desktop block-panel swap re-verified here.)
- Component tests for the panel (section visibility per capability flags, action
  bar states).
- Changeset (user-facing, present tense): describes the redesigned editor layout.
- Final pass: `pnpm lint:json`, `pnpm typecheck`, admin tests, RTL screenshot
  check.

## Out of scope (open Discussions instead if wanted)

- Draft/Published as navigable tabs (Loops' sub-nav) — interesting, defer.
- "Edit with agent" style AI affordances.
- Any changes to other admin routes' layout.
