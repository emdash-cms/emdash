# Editor image panel UI and alignment correctness

Status: Implemented locally with Option A. Automated checks pass; manual verification coverage and remaining checks are recorded below.

Delivery: one pull request from `fix/editor-edit-image-panel`, with four panel commits and two follow-up commits for responsive sizing and converter compatibility.

Base: `8c414791f`. The authorized rebase is complete and includes in-context media asset editing from `main`.

The rebase retains this specification's sidebar UI and `main`'s Edit asset flow, `nodeKey` state reset, local asset snapshot, error state, and nested-overlay shortcut ownership.

Authority: the user approved Option A, local implementation with `$feat-implement`, and the rebase. Pushing and GitHub changes require separate authorization.

## User outcome

Editors can change an image's alignment without changing its display dimensions or aspect ratio. None, Left, Center, and Right produce visibly different layouts in the editor. Image alignment survives both the admin's private Portable Text conversion and the exported core converters.

The panel retains the approved Option 1 information architecture and normal editor-sidebar styling: all fields stay visible, help uses the existing information tooltip, Remove image uses the Kumo secondary-destructive resting surface, and Cancel and Apply remain in the action footer.

## Included scope

- Preserve absent `displayWidth` and `displayHeight` when Apply changes only alignment or text fields.
- Make Reset remove custom display overrides instead of persisting the original dimensions as overrides.
- Keep implicit display dimensions synchronized when Edit asset changes the original media dimensions on current `main`.
- Render editor images responsively so container shrinkage does not stretch the image vertically.
- Give None and Center distinct rendered positions.
- Resolve the misleading Wide and Full choices according to the approved product decision in [Wide and Full](#wide-and-full).
- Add `alignment` to the exported core Portable Text image contract and preserve it in both conversion directions.
- Deliver the existing panel refinement and these fixes in one pull request.

## Excluded scope

- Do not add crop, focal-point, rendition, upload, or media metadata capabilities.
- Do not change asset-editor behavior introduced on `main` except where its updated original dimensions interact with implicit display size.
- Do not change provider normalization, replacement identity, media URLs, or saved asset references.
- Do not change Gallery, featured-image fields, Widgets' fixed panel presentation, text alignment, or non-image blocks.
- Do not add a database migration, API route, query, cache entry, background task, or logged-out-route query.
- Do not edit extracted `messages.po` catalogs.
- Do not create a shared layout framework for unrelated Portable Text blocks.

## Audit findings before implementation

### Panel and image state

- `ImageDetailPanel` initializes each displayed dimension from `displayWidth ?? width` and `displayHeight ?? height`.
- `handleSave` always sends the displayed dimension values. A 1200 by 800 image with no custom display size therefore receives `displayWidth: 1200` and `displayHeight: 800` when an editor changes only Alignment.
- `ImageNode` applies custom width and height as independent pixel styles while also limiting only width with `max-w-full`. When the editor column narrows, the browser shrinks the width but retains the fixed height. The measured 1200 by 800 image became 237 by 800 after Left was applied.
- Reset currently copies the original dimensions into the same state that is persisted as a custom override.
- TipTap can supply absent optional attributes as `null` even though the TypeScript panel interface represents them as optional. The fix must treat both `null` and `undefined` as absent at this boundary.
- Current `main` keeps a local asset snapshot and attempts to update implicit dimensions after Edit asset while preserving custom instance dimensions. Its check recognizes only `undefined`, so TipTap's `null` form can prevent an implicit size from following the edited asset. The semantic-state fix covers both forms.

### Alignment rendering

- The editor image always has `mx-auto`. None and Center therefore look the same for an image narrower than the text column.
- Center already places the node wrapper at the center. The unconditional image auto-margin duplicates that behavior and affects None.
- Left and Right float the node wrapper and limit it to half of the text column. The public renderer removes the float below 640px, but the editor does not currently match that narrow behavior.
- Wide and Full both set the wrapper to `width: 100%` in the editor.
- The public renderer also maps Wide and Full to the same `width: 100%` figure rule. Its default figure is already a block that spans the containing column, and its image keeps its intrinsic width, so either option can produce no visible change.
- `Image.astro` is used in top-level articles and bounded Portable Text hosts such as Widgets, and consumers can render it inside custom containers. A viewport-width Full rule inside the image component can escape its host and overlap adjacent content.

### Portable Text conversion

- The admin's private converters in `PortableTextEditor.tsx` already preserve `alignment` in both directions.
- The exported `PortableTextImageBlock` in core omits `alignment`.
- The exported ProseMirror-to-Portable-Text and Portable-Text-to-ProseMirror converters omit `alignment`.
- The core converters are re-exported from the public `emdash` package, so adding the optional field is an additive public type and behavior change.
- The Gutenberg importer already emits `left`, `center`, `right`, `wide`, and `full`. Existing imported content may therefore contain either unresolved Wide or Full value.

## Panel information architecture

The implemented inline panel keeps every setting visible in this order:

```text
Image settings                                      Close
---------------------------------------------------------
Image preview
                               Replace / Edit asset actions
Original: 1200 x 800
---------------------------------------------------------
Display size [help]                         Reset
Width                 [aspect ratio]              Height
Alignment
---------------------------------------------------------
Alt text [help]
Caption
Tooltip text
Source + Open in new tab (external images only)
---------------------------------------------------------
Remove image
---------------------------------------------------------
                                      Cancel      Apply
```

The rebase must retain the implemented header, 16px content gutter, section separators, label and tooltip patterns, responsive rows, secondary-destructive Remove image button, and content-editor-only sticky action footer. It must incorporate `main`'s Replace and Edit asset action row without restoring the old nested card or hover-only action.

### Sidebar parity preservation

- Keep the content editor's panel unframed and full width. Keep Section editor's outer card and Widgets' fixed panel presentation unchanged.
- Use one 16px inline gutter. Keep `px-4 py-3` on the header and footer, `p-4` on content sections, `space-y-4` between full fields, and `gap-2` within compact rows.
- Keep the Kumo `Text` heading, one square ghost close button, structural section borders, and no decorative header icon.
- Keep the transparency-grid preview, quiet Kumo line ring, contained image fit, original-dimensions row, and tabular dimension numerals.
- Reconcile `main` by showing Replace and Edit asset as always-visible Kumo secondary buttons beneath the preview. Do not make pointer hover a prerequisite for either action.
- Keep `FieldHelpLabel` for Display size and Alt text, Kumo number inputs in the shrink-safe dimension row, the named display-size group, and the pressed aspect-ratio button.
- Keep the full-width Kumo Alignment Select, Alt text, Caption, Tooltip text, and conditional read-only Source row in the approved order.
- Keep Remove image as a full-width Kumo secondary-destructive button with its normal surfaced resting state and pale danger hover treatment.
- Keep the end-aligned Cancel and Apply footer sticky only in the content editor. Apply remains disabled when the semantic draft has not changed.
- Use Kumo semantic tokens only. Do not add raw colors, `dark:` variants, custom tracking, shadows, or nested decorative cards.

## Display-size state

Keep the width and height input values separate from whether the image has a custom display size. This can remain local React state; no shared abstraction is required.

Initialize the state as follows:

- Normalize each incoming display dimension to a number or absent. Treat `null` and `undefined` as absent.
- For an implicit size, show the current asset's original dimensions as editable fallbacks. For a custom size, show the saved overrides and leave an omitted axis blank so it remains derived by the renderer.
- Mark the draft as custom when at least one normalized display dimension exists.

Update the state as follows:

- Changing either dimension marks the draft as custom. Aspect-ratio locking continues to update the paired field when the original ratio is known.
- Reset shows the latest asset dimensions and marks the draft as not custom.
- If Edit asset changes the original width or height while the draft is not custom, update the displayed fallback values to the edited asset's dimensions.
- If Edit asset changes the original width or height while the draft is custom, preserve the custom values.
- Switching to another image node through `nodeKey` rebuilds all dimension state from that node. Do not carry a custom-state flag between nodes.

Apply uses the semantic state:

- When the draft is custom, send its numeric display dimensions. An intentionally cleared dimension remains absent so the renderer can derive it from the original aspect ratio.
- When the draft is not custom, send `displayWidth: undefined` and `displayHeight: undefined` even though the inputs show the original dimensions.
- Alignment-only and text-only Apply therefore preserve the absence of display overrides.
- Reset on an image that has custom dimensions is a meaningful change and enables Apply.
- The unchanged initial state keeps Apply disabled.

Update the Display size tooltip to state both behaviors: `Set a custom width and height for this image in the document. Reset uses the original media dimensions. The original media file is unchanged.`

## Responsive editor rendering

Calculate the editor's effective render dimensions with the same cases as `Image.astro`:

1. Use both custom dimensions when both exist.
2. Derive height from the original aspect ratio when only custom width exists.
3. Derive width from the original aspect ratio when only custom height exists.
4. Otherwise, use the original dimensions.

Expose the effective values as image width and height attributes for intrinsic sizing. When both effective values exist, expose their ratio through CSS `aspect-ratio`. Keep the rendered image at a maximum inline size of 100% and an automatic block size so a narrow editor scales both axes together while preserving the effective ratio. Do not apply an independent fixed pixel height after the inline size has been clamped.

Remove the unconditional auto margin from the image. None uses the normal inline-start position. Center continues to center the node wrapper. Left and Right retain their existing imported physical alignment semantics and match the public renderer's narrow-screen unfloat behavior.

The inline selection actions and caption stay attached to the figure. Selection rings must follow the visible image block without causing horizontal overflow.

The editor root establishes a block formatting context with `flow-root`. Final browser review reproduced a floated image being clipped below the editor footer when it ended a document; the root must include the float in its height.

## Alignment contract

The supported authoring choices have the following meanings:

| Value  | Editor behavior                                                       | Public behavior                                       |
| ------ | --------------------------------------------------------------------- | ----------------------------------------------------- |
| None   | Natural or custom size at inline start                                | Natural or custom size in normal document flow        |
| Left   | Physical left float, at most half-column above the narrow breakpoint  | Existing physical left float and narrow-screen block  |
| Center | Natural or custom size centered in the text column                    | Natural or custom size centered in the text column    |
| Right  | Physical right float, at most half-column above the narrow breakpoint | Existing physical right float and narrow-screen block |

`ImageAttributes` and the core `PortableTextImageBlock` retain the existing string values. The panel's None sentinel maps to an absent value. Unknown runtime values are not emitted by the exported ProseMirror converter.

### Wide and Full

Option A is approved. Option B is retained below as the rejected alternative.

#### Option A: disable unsupported authoring choices (approved)

- Remove Wide and Full from the normal panel choices because EmDash has no parent layout contract that can distinguish them safely in articles, columns, widgets, and user-defined Portable Text hosts.
- Preserve existing `wide` and `full` values through all converters and rendering hooks. Do not normalize or delete imported content.
- Render Wide and Full as disabled compound `Select.Option` entries. Kumo supports disabled options. Add a focused component case proving that a controlled imported Wide or Full value remains visible and preserved while the editor can select one of the four supported values to change away from it.
- Keep the public alignment class hooks so a site theme that already defines Wide or Full behavior continues to work.
- Defer a new container-aware Wide and Full authoring contract to a separate feature proposal.

This option gives the panel four selectable choices. Existing Wide and Full values remain visible and preserved until an editor chooses a supported alignment.

#### Option B: define real default breakout behavior (not selected)

- Wide scales the image to the full text-column width.
- Full breaks out beyond the text column. In the admin it fills the known editor surface, including the editor's inline padding. In public rendering it uses a defined full-bleed rule.
- Wide and Full take precedence over custom display dimensions while selected. Keep the custom values stored so switching back to None, Left, Center, or Right restores the instance size.
- Add narrow viewport and right-to-left containment behavior.
- Add public browser coverage in a top-level article and a nested Portable Text host before accepting the CSS.

This option preserves all six choices and makes them visibly different, but it changes existing public rendering. A viewport-based Full rule is not acceptable unless the nested-host test proves it cannot overlap Columns, Widgets, or another bounded host. If that proof requires a new Portable Text layout wrapper or public host contract, stop and move the breakout work to a separate specification rather than expanding this pull request.

## Converter compatibility

- Add optional `alignment?: "left" | "center" | "right" | "wide" | "full"` to core's exported `PortableTextImageBlock`.
- Preserve a valid ProseMirror image alignment when converting to Portable Text.
- Preserve `block.alignment` when converting a valid Portable Text image to ProseMirror.
- Preserve a valid alignment on the existing malformed-image recovery path so recovery does not discard the field.
- Omit unknown alignment strings in both conversion directions rather than widening the public union or carrying invalid values into a renderer class.
- Do not change keys, media references, provider IDs, source URLs, captions, original dimensions, or display dimensions.
- Do not migrate stored content. The optional field is backward compatible with images that omit it.

Because core's exported contract changes, update `.changeset/calm-images-fit.md` to include patch entries for both `@emdash-cms/admin` and `emdash`. The text must describe the observable alignment and sizing corrections without promising Wide or Full behavior beyond the approved option.

## Accessibility, localization, RTL, and responsive behavior

- Localize every new visible string, help message, and accessible name through Lingui. Do not commit extracted catalogs.
- Keep the visible Alignment label and full-width Kumo Select.
- Preserve one mobile close control, keyboard-operable help, Replace, Edit asset, Cancel, Apply, and Remove image confirmation.
- While the media picker, asset editor, or removal confirmation is open, the nested overlay owns Escape and Cmd/Ctrl+S.
- Keep DOM and focus order equal to visual order.
- Use logical Tailwind properties for panel and editor layout. Left and Right image values remain physical only because that is their stored WordPress-compatible meaning.
- At widths of 200px, 320px, 368px, and 480px and at 200% zoom, the panel and rendered image stay inside their available surfaces.
- Verify English, pseudo-localization, Arabic, light and dark appearance, reduced motion, keyboard-only use, and touch-visible media actions.

## Behavioral tests

### Panel component tests

Extend `packages/admin/tests/components/ImageDetailPanel.test.tsx` after reconciling the tests added on `main`:

- Given original dimensions and absent display overrides, changing only Alignment and applying sends absent display dimensions.
- Changing text only also leaves display dimensions absent.
- Editing a dimension sends a custom override and keeps aspect-ratio synchronization.
- Resetting an existing custom size sends absent display dimensions and enables Apply.
- `null` and `undefined` optional dimensions both behave as absent.
- Edit asset updates displayed fallback dimensions when no override exists and preserves custom instance dimensions when one exists.
- Switching `nodeKey` does not carry the previous image's custom-size state.
- Existing Apply, Cancel, shortcut, nested-overlay, replacement, provider, Edit asset, and Remove image cases remain green.

These tests assert the `onUpdate` behavior seen by the editor. They do not assert local state variable names or Tailwind classes.

### Editor browser tests

Add `packages/admin/tests/editor/image-alignment.test.tsx` or another narrowly named browser test:

- Apply an alignment-only update to a 1200 by 800 image in a narrower editor and assert that the rendered aspect ratio remains 3:2 and the node retains absent display overrides.
- Render a small image with None and Center and assert their positions differ: None begins at the available inline start and Center is centered.
- Verify Left and Right wrapping behavior above the breakpoint and full-width block behavior below it.
- For Option A, verify Wide and Full are not offered as normal choices and an existing imported value round-trips unchanged.
- For Option B, verify the ordered visible widths `None < Wide < Full` in the editor without exact pixel snapshots.

Use an image fixture with known intrinsic dimensions. Geometry assertions compare relationships and containment, not exact design pixels.

### Core converter tests

Extend the focused converter coverage under `packages/core/tests/unit/converters/`:

- Portable Text to ProseMirror to Portable Text preserves each valid alignment.
- ProseMirror to Portable Text to ProseMirror preserves each valid alignment.
- An image without alignment remains without alignment.
- The malformed-image recovery path preserves a valid alignment.
- Unknown alignment input is omitted in both conversion directions.
- Existing dimension round-trip behavior remains green.

### End-to-end and public rendering

Extend `e2e/tests/editor-image-panel.spec.ts`:

- Insert an image with known original dimensions, change only alignment, apply, and confirm the editor image remains proportional and contained.
- Reopen the panel and confirm the original fallback dimensions are shown without becoming custom overrides.
- Save and reload the post and confirm the alignment remains selected.
- Keep the existing narrow panel, focus-visible media action, destructive-button, and Cancel coverage.

For Option B, create isolated published content and compare Wide and Full layout in the public post route. Do not mutate shared seed content. Verify a bounded nested host as required by the option's stop condition. Do not use screenshot equality or exact pixel values.

### Manual verification

- Reproduce the original 1200 by 800 image case for None, Left, Center, and Right.
- Resize the desktop editor sidebar and the browser while each alignment is active.
- Edit the underlying local asset with and without custom display dimensions.
- Verify alignment and sizing after Save, reload, and public rendering.
- Verify the chosen Wide and Full behavior or absence in both a top-level post and a nested host.
- Repeat the panel checks in Arabic, dark appearance, reduced motion, keyboard-only use, touch emulation, and 200% zoom.

## Expected files and line estimates

Expected production files:

- `packages/admin/src/components/editor/ImageDetailPanel.tsx`: 30-65 changed lines after rebase conflict resolution.
- `packages/admin/src/components/editor/ImageNode.tsx`: 20-45 changed lines.
- `packages/admin/src/components/PortableTextEditor.tsx`: one class addition for the float-containment defect reproduced during final browser review.
- `packages/core/src/content/converters/types.ts`: 2-6 changed lines.
- `packages/core/src/content/converters/prosemirror-to-portable-text.ts`: 8-18 changed lines.
- `packages/core/src/content/converters/portable-text-to-prosemirror.ts`: 4-12 changed lines.
- `packages/core/src/components/Image.astro`: 0-30 changed lines, depending on the Wide and Full decision.

Expected test, specification, and release-note files:

- `packages/admin/tests/components/ImageDetailPanel.test.tsx`: 50-100 changed lines after reconciling `main`.
- `packages/admin/tests/editor/image-alignment.test.tsx`: 60-120 new lines.
- `e2e/tests/editor-image-panel.spec.ts`: 25-70 changed lines.
- `packages/core/tests/unit/converters/image-dimensions.test.ts` or a focused alignment sibling: 35-70 changed lines.
- `packages/core/tests/repro/image-render.render.test.ts`: 0-35 changed lines, depending on the Wide and Full decision.
- `.changeset/calm-images-fit.md`: 4-8 changed lines.
- `docs/technical-specs/editor-image-panel-ui.md`: this specification update, approximately 340 additions and 200 removals from the earlier panel-only plan.

The expected additional production change is 65-145 lines. Stop for scope review above 170 production lines, if a seventh production file is required, or if the solution needs a new Portable Text wrapper, page-layout API, database/API work, Gallery changes, or locale catalog edits. Test lines may exceed the estimate only when required to cover `main`'s asset-editor integration without duplicating its existing cases.

## Sequential commit plan

The existing local commits remain part of the same pull request:

1. `fix(admin): contain image settings in editor sidebar`
2. `refine(admin): align image settings with the editor sidebar`
3. `fix(admin): reserve image danger tint for hover`
4. `fix(admin): use a surfaced image removal action`

The rebase is complete. Each follow-up commit uses the sequence `plan -> failing tests -> implementation -> adversarial review -> patch -> re-review -> checks -> scope audit -> local commit`.

### Commit 5: preserve responsive image instance sizing

Responsibility: fix semantic display-size state, alignment-only Apply, Reset, asset-edit dimension updates, responsive editor sizing, and the None versus Center rendering difference.

Production files:

- `packages/admin/src/components/editor/ImageDetailPanel.tsx`
- `packages/admin/src/components/editor/ImageNode.tsx`

Tests:

- `packages/admin/tests/components/ImageDetailPanel.test.tsx`
- `packages/admin/tests/editor/image-alignment.test.tsx`
- The focused alignment portion of `e2e/tests/editor-image-panel.spec.ts`

Acceptance: an alignment-only update cannot create display overrides; editor images remain proportional when constrained; None and Center are visibly distinct; current `main`'s Edit asset behavior remains intact.

Exclusions: no exported core converter or public renderer change.

### Commit 6: preserve image alignment across public contracts

Responsibility: add the optional exported field, preserve it through both core converter directions and malformed recovery, implement the approved Wide and Full decision, and update the shared changeset.

Production files:

- `packages/core/src/content/converters/types.ts`
- `packages/core/src/content/converters/prosemirror-to-portable-text.ts`
- `packages/core/src/content/converters/portable-text-to-prosemirror.ts`
- `packages/admin/src/components/editor/ImageDetailPanel.tsx` or `ImageNode.tsx` only if the approved Wide and Full option requires it
- `packages/core/src/components/Image.astro` only if the approved option changes public rendering
- `packages/admin/src/components/PortableTextEditor.tsx`: contain floated images at the end of the document, covered by the saved-content browser regression.

Documentation:

- `docs/technical-specs/editor-image-panel-ui.md`
- `.changeset/calm-images-fit.md`

Tests:

- Focused core converter tests
- Wide and Full editor or public browser behavior required by the approved option
- Remaining `e2e/tests/editor-image-panel.spec.ts` persistence coverage

Acceptance: valid alignment survives the exported round-trip, invalid runtime values are omitted, existing content remains readable, and Wide and Full follow the approved contract.

Exclusions: no generalized Portable Text layout system unless a separate specification is approved.

## Required checks

- Run `pnpm lint:quick` after every edit.
- Run the focused admin browser component tests after each admin round.
- Run the focused core converter tests and `pnpm --filter emdash test:repro` when `Image.astro` changes.
- Run the focused Playwright scenario against this worktree's available local port.
- Run `pnpm --filter @emdash-cms/admin typecheck` and the core package typecheck.
- Build admin, core, and the simple demo after the rebase and final implementation.
- Run targeted formatting, `git diff --check`, and `pnpm lint:json | jq '.diagnostics | length'`; the final diagnostic count must be zero.
- Confirm no extracted locale catalogs, unrelated generated files, or unrelated changes enter the diff.

## Review gates

- Reject any fix that tests only a class string, local state name, or callback echo instead of rendered or serialized behavior.
- Reject any fix that writes original dimensions as display overrides.
- Reject any image sizing rule that clamps one axis while retaining an independent fixed size on the other.
- Reject any converter change that drops provider, source, media identity, captions, LQIP data, or dimensions.
- Reject a conflict resolution that removes `main`'s Edit asset action, asset refresh, node reset, error state, or nested-overlay shortcut handling.
- Reject viewport Full CSS without passing the nested-host containment scenario.
- Stop if the Wide and Full decision is still unresolved.

## Acceptance criteria

- The existing inline panel retains normal editor-sidebar spacing, typography, Kumo controls, tooltips, responsive containment, action hierarchy, and Remove image styling.
- Alignment-only and text-only Apply preserve absent display overrides.
- Reset removes existing display overrides and uses the latest original media dimensions.
- Edit asset updates implicit dimensions and preserves explicit instance dimensions.
- Editor images preserve their configured aspect ratio when the available width shrinks.
- None and Center render differently for images narrower than the text column.
- Left and Right match public narrow-screen behavior.
- Valid alignment survives both exported core conversion directions and malformed-image recovery.
- The approved Wide and Full policy is implemented and tested without data loss or host-layout overflow.
- Local, direct-URL, and configured-provider images retain their source and provider identity.
- English, Arabic, 200% zoom, light and dark appearance, reduced motion, keyboard, and touch checks pass.
- The complete work remains one pull request with the existing four commits and two reviewed follow-up commits.

## Approved product decision

Option A disables Wide and Full for new selections and preserves imported values and theme hooks. Imported Wide and Full values retain their existing default rendering. A container-aware breakout layout contract is outside this pull request.

## Implementation authorization

The user has authorized the six local commits in this worktree and approved the rebase onto `main`. This implementation does not include pushing, opening or modifying a pull request, or merging.

## Implementation verification

The final implementation was checked on September 7, 2026, in `/private/tmp/emdash-editor-edit-image-panel`, with the simple demo served on port 4321.

- All 117 focused admin tests pass across the panel, Portable Text editor, image rendering, and image selection suites.
- All 64 core converter tests pass, including valid alignment round-trips, malformed-image recovery, and invalid runtime values.
- The Playwright image-panel scenario passes against the running demo. It checks containment at 200px, image proportions, disabled options, keyboard-visible replacement, Remove image hover styling, Apply, Cancel, and saved/reloaded alignment without display overrides. Its scratch draft is moved to Trash.
- The corrected float-containment test targets the editable root, not TipTap's non-editable node wrapper. Removing `flow-root` reproduces the failure; restoring it makes the same test pass.
- Full workspace typecheck, type-aware lint with zero diagnostics, admin/core/simple-demo builds, targeted formatting, changeset validation, and diff whitespace checks pass.
- Visual inspection covers English and Arabic, light and dark appearance, and the narrow Arabic panel. Arabic at 320px and 480px remains contained with reduced motion enabled. Focused browser tests cover keyboard help, save/cancel shortcuts, and nested-overlay ownership.

Review also found and corrected an unlocked first resize losing the untouched original dimension. The existing full-width None selection surface remains so small images retain reachable action buttons. No further material in-scope findings remain after re-review.

The alignment follow-up changes 149 production lines across six files, below the 170-line and seventh-file stop gates. There are no public breakout CSS, database/API, Gallery, dependency, or locale-catalog changes.

Actual browser 200% zoom, touch-device emulation, and pseudo-localization have not been verified. The focused checks do not replace the full repository test suite or remote CI. Vitest reports the existing mixed-version warning (4.1.5 and browser 4.1.10); the passing runs do not require dependency changes.
