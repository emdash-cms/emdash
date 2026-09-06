# Editor image panel strict-parity refinement

Status: Implemented locally

Dependency: the local `fix/editor-edit-image-panel` overflow fix based on `603062902` must land first. That change keeps the mobile settings sheet inside the viewport, removes the nested card from the content editor host, and lets image fields shrink without horizontal overflow.

Intended stack position: one focused follow-up commit after the overflow fix.

Authority: design only. This document does not authorize source-code changes, commits, pushes, pull requests, rebases, merges, or other Git or GitHub mutation.

## Summary

Refine the inline rich-text image settings panel to match the normal content editor sidebar while keeping all image controls visible. The panel will use the sidebar's existing Kumo typography, 16px content gutter, section separators, native help tooltip, sentence-case copy, and explicit action hierarchy.

The refinement preserves the current staged form model. Editors change image fields locally, choose **Apply** to update the Portable Text image node, or choose **Cancel** to close the panel without applying those local field changes. Replacing or removing the image keeps its existing behavior.

## Goals

- Make the image settings panel read as part of the normal content editor sidebar rather than a separate embedded form.
- Keep the complete Option 1 field set visible without progressive disclosure.
- Use Kumo components and existing EmDash sidebar patterns for headings, labels, inputs, selection, help, and actions.
- Make the Replace image action available to pointer, keyboard, and touch users.
- Keep the panel usable in light and dark appearance, Arabic and right-to-left layouts, 200% zoom, and widths from 200px through the desktop maximum of 480px.
- Preserve the existing image attribute, provider, replacement, removal, and save contracts.

## Non-goals

- Do not add asset editing, crop, focal-point, rendition, upload, or media metadata capabilities.
- Do not add Instance and Asset tabs or adopt the asset-inspector direction.
- Do not add progressive disclosure or collapse any field.
- Do not change `ImageAttributes`, Portable Text serialization, image rendering, alignment semantics, or provider normalization.
- Do not change `GalleryDetailPanel`, the inline image toolbar, or featured-image fields.
- Do not restyle the fixed `ImageDetailPanel` presentation used by Widgets.
- Do not change database, API, authorization, query, cache, or logged-out-route behavior.
- Do not edit extracted `messages.po` catalogs in this pull request.

## Verified current behavior

- `ImageNode` opens an `ImageDetailPanel` through the existing block-sidebar callbacks. `ContentSettingsPanel` replaces the normal settings sections while that block panel is active.
- `ContentEditor` renders the block panel inside the resizable desktop sidebar and auto-opens the Kumo mobile settings sheet below 1024px.
- The inline image panel is also used by `SectionEditor`. Its outer card surface must remain intact there; only the content editor host supplies the unframed sidebar surface.
- Widgets use the fixed `ImageDetailPanel` branch. That branch has separate markup and remains outside this refinement.
- Alt text, caption, tooltip text, display width, display height, and alignment live in local React state. `handleSave` sends one `onUpdate` patch and closes the panel.
- Media replacement calls `onReplace` with the selected media identity, dimensions, placeholder metadata, and canonical provider, then closes the panel.
- Image removal uses the existing `ConfirmDialog` before calling `onDelete` and closing the panel.
- The preview's Replace Image button is currently hidden behind a hover-only opacity layer.
- Alignment currently uses six wrapping buttons. The normal settings sidebar uses Kumo `Select` for comparable single-choice fields.
- `FieldHelpLabel` is the existing label-and-help pattern. It uses Kumo `Tooltip` with `delay={0}`, `closeDelay={0}`, an `xs` square ghost information button, a 6px label gap, and an accessible trigger name.
- The dependency already includes a behavioral Playwright regression that opens the panel at 200px and checks the settings sheet and panel for horizontal containment.

## Information architecture

The inline panel keeps every setting visible in this order:

```text
Image settings                                      Close
---------------------------------------------------------
Image preview
                                    Replace image action
Original: 1200 × 800
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

The preview, display controls, text fields, destructive action, and footer are separate sections. Section borders provide structure; individual fields use spacing rather than additional dividers or cards.

## Visual contract

### Sidebar surface

- Keep `ContentSettingsPanel`'s unframed, full-width image-panel integration from the overflow dependency.
- Add one optional internal host flag for the content editor's sticky action footer. `ContentSettingsPanel` enables it; `SectionEditor` leaves it disabled.
- Keep the `SectionEditor` inline card surface unchanged.
- Use `bg-kumo-base` for the panel and `border-kumo-line` through the repository's inherited border token.
- Use one 16px inline gutter for the header and every section. Do not introduce nested content gutters.
- Use `px-4 py-3` for the header and footer. Use `p-4` for content sections.
- Use `space-y-4` between full fields and `gap-2` within compact control rows.
- Do not add shadows, decorative cards, raw Tailwind colors, `dark:` variants, or custom letter spacing.

### Header

- Render `Image settings` with Kumo `Text` as an `h3` using the normal bold heading treatment from `ContentSettingsPanel`.
- Remove the `SlidersHorizontal` decoration from the inline header. The heading already names the surface.
- Keep one square ghost close button at the inline end with the accessible name `Close image settings`.
- When the image panel is active below 1024px, suppress the generic `MobileSettingsCloseButton`. The panel close button clears the block panel, and `MobileBlockSidebarSync` closes the sheet. Normal settings and gallery panels keep their existing mobile close behavior.

### Preview and replacement

- Keep the existing transparency grid, contained image fit, and `rounded-lg` preview.
- Add a quiet `ring-1 ring-kumo-line` to separate light or transparent media from the panel background without changing layout.
- Keep Replace image as a Kumo secondary button over the preview.
- Show the replacement control on pointer hover and `focus-within`. Keep it visible when the device has no hover capability so touch users never depend on a hidden affordance.
- Use `motion-safe:transition-opacity`; reduced-motion users receive the immediate state.
- Keep replacement selection, provider normalization, and panel-close behavior unchanged.
- Render original dimensions beneath the preview in one Kumo text row. Mark the ruler icon decorative and apply `tabular-nums` to the numeric value.

### Display size and alignment

- Use `FieldHelpLabel` for `Display size`.
- Use this localized tooltip copy: `Set a custom width and height for this image in the document. The original media file is unchanged.`
- Keep Reset at the inline end as a small ghost Kumo button. Use the sentence-case label `Reset`.
- Keep Width and Height as Kumo number inputs in the existing shrink-safe row from the overflow dependency.
- Wrap Width, Height, and the aspect-ratio toggle in one `role="group"` with the localized accessible name `Display size`. Keep the visible `FieldHelpLabel` outside the control row so it is not duplicated as an input label.
- Render the aspect-ratio control as a square ghost Kumo button wrapped in a native Kumo tooltip. Expose `aria-pressed={lockAspectRatio}` with the stable accessible name `Keep aspect ratio`; use the existing link and broken-link icons for the visual state.
- Replace the six alignment buttons with one full-width Kumo `Select` labeled `Alignment`. Use the localized options None, Left, Center, Right, Wide, and Full. Map the UI sentinel `none` back to `undefined` when applying image attributes.

### Text fields and help

- Keep Alt text, Caption, Tooltip text, and the conditional external Source field visible.
- Use `FieldHelpLabel` for `Alt text` with this localized tooltip copy: `Describe the image's purpose and relevant details for people who cannot see it.`
- Generate the Alt text input ID with `React.useId`, pass it to both `FieldHelpLabel.htmlFor` and the Kumo `Input`, and keep the input's accessible name equal to its visible label. Do not render a second Kumo input label.
- Wrap both help messages in `<span className="block max-w-64 text-pretty">` so native tooltip collision handling receives a bounded text measure.
- Rename the visible source label `Title (Tooltip)` to `Tooltip text`. Continue reading and writing the existing `title` image attribute.
- Use the concise placeholders `Describe the image`, `Optional caption`, and `Optional hover text`.
- Remove the three persistent description paragraphs. The alt-text requirement belongs in its tooltip; Caption and Tooltip text are already explained by their labels and placeholders.
- Keep the external Source input read-only and shrink-safe. Keep `LinkButton` for Open in new tab and give its icon `aria-hidden="true"`.

### Destructive and apply actions

- Move Remove image into its own final content section, matching the normal sidebar's placement of Move to Trash after editable settings.
- Keep the existing `ConfirmDialog`, but use sentence-case copy: `Remove image?`, `Remove this image from the document?`, `Remove`, and `Removing...`.
- Add a sticky footer with a structural top border, `bg-kumo-base`, and end-aligned Kumo buttons.
- Make the footer sticky only when the content editor hosts the panel. The Section editor footer remains in normal flow, and the excluded fixed Widgets branch is unchanged.
- Use an outline Cancel button and the default primary Apply button. Apply remains disabled until `hasChanges` is true.
- Cancel, the panel close button, and Escape close the panel without calling `onUpdate`. They discard only the panel's staged local field state.
- Apply sends the existing single `onUpdate` patch and closes the panel. Cmd/Ctrl+S performs the same action.
- When `hasChanges` is false, Cmd/Ctrl+S prevents the browser Save dialog but leaves the panel open and does not call `onUpdate`, matching the disabled Apply button.
- While the media picker or removal confirmation is open, the nested overlay owns Escape and keyboard input. The panel shortcut handler must not close or apply the parent panel.

## Compatibility and data flow

- The change is internal to `@emdash-cms/admin`; it does not add or change a public API.
- Any host-only footer flag is optional and remains inside non-exported admin component wiring.
- `ImageAttributes` and every stored value keep their current meaning.
- `onUpdate`, `onReplace`, `onDelete`, and `onClose` retain their current signatures and ownership.
- Provider IDs continue through `canonicalMediaProviderId` during replacement.
- Existing image nodes, external images, migrated images without original dimensions, and images without optional text remain valid.
- The refinement performs no fetches, database queries, writes, background work, retries, or new logged-out-route work.
- Update the existing `.changeset/calm-images-fit.md` entry instead of creating a second changeset. The entry must describe both horizontal containment and the aligned image-settings layout.

## Accessibility, localization, and responsive behavior

- Localize every visible string, tooltip, placeholder, title, and accessible name through Lingui.
- Use sentence case. Do not include extracted catalog changes.
- Use Kumo controls so focus, disabled, hover, dark appearance, and forced-color behavior remain consistent with the admin.
- Keep the DOM order equal to the visual order: preview, display settings, text fields, removal, footer.
- Every icon-only control needs a specific accessible name; decorative icons use `aria-hidden="true"`.
- Tooltip triggers must work by hover and keyboard focus. Test visible tooltip copy instead of relying on `role="tooltip"`.
- At 200% zoom and widths of 200px, 320px, 368px, and 480px, the sheet and panel must remain inside the viewport with no horizontal scrolling. Labels may wrap; controls may not overlap or clip.
- Use logical Tailwind properties only. Verify the header, dimension row, Select, source row, destructive action, and footer in Arabic with `dir="rtl"`.
- The sticky footer must remain reachable without covering the final content section.

## Test plan

Add behavior-level coverage that can fail when the editor experience regresses.

### Browser component tests

Extend `packages/admin/tests/components/ImageDetailPanel.test.tsx` to cover:

- Alt-text and display-size help copy becomes visible from the existing Kumo tooltip trigger by pointer and keyboard focus.
- Changing Alignment through the Kumo Select and choosing Apply sends the expected `alignment` value in the existing `onUpdate` patch.
- None maps to `alignment: undefined`.
- Apply is disabled for the initial state and enabled after a meaningful text, dimension, or alignment change.
- Cancel and the specific close button call `onClose` without calling `onUpdate`.
- The aspect-ratio control exposes the correct stable name and `aria-pressed` state while preserving width-height synchronization.
- The display-size controls expose one named group containing the two inputs and aspect-ratio toggle.
- Remove image still requires confirmation before `onDelete`.
- Cmd/Ctrl+S applies changed staged values, does nothing to an unchanged panel, Escape cancels, and neither parent shortcut runs while the media picker or confirmation dialog is open.
- Existing local and external replacement-provider cases remain green with sentence-case button names.

Do not assert Tailwind class strings, exact pixels, tooltip roles, or implementation-only component calls.

### End-to-end behavior

Extend `e2e/tests/editor-image-panel.spec.ts` to cover the rendered admin CSS:

- The panel opens on a new post, keeps one visible `Close image settings` control, and hides the generic Close settings control while active on mobile.
- The settings sheet and panel remain horizontally contained at 200px.
- Keyboard focus reveals Replace image and can open the media picker without pointer hover.
- Editing alt text, choosing an alignment, and applying updates the image node; reopening the panel shows the applied values.
- Cancel closes the panel without applying a staged field change.

Keep the test independent of shared seed content and avoid screenshot, exact geometry, scroll-offset, or animation-duration assertions.

### Manual verification

- Compare the image panel with Publish, Ownership, Bylines, and SEO in the normal sidebar at 368px and 480px.
- Verify light and dark appearance.
- Verify English, pseudo-localization, and Arabic at 200px and 320px.
- Complete the panel with keyboard only, including help, Select, Replace image, Cancel, Apply, and Remove image confirmation.
- Verify 200% browser zoom and reduced motion.
- Verify the Section editor retains its card surface and Widgets retains its fixed panel presentation.
- Capture before-and-after screenshots with useful alt text for the pull request.

## Expected files and line estimates

Expected production files:

- `packages/admin/src/components/editor/ImageDetailPanel.tsx`: 70-120 changed lines.
- `packages/admin/src/components/ContentEditor.tsx`: 2-8 changed lines for the duplicate mobile-close suppression.
- `packages/admin/src/components/ContentSettingsPanel.tsx`: 1-4 changed lines to select the content-sidebar footer behavior.

Expected test and release-note files:

- `packages/admin/tests/components/ImageDetailPanel.test.tsx`: 60-110 changed lines.
- `e2e/tests/editor-image-panel.spec.ts`: 25-60 changed lines.
- `.changeset/calm-images-fit.md`: 1-3 changed lines.

No other production file is expected. The warning threshold is 150 changed production lines. The implementation must stop for review above 220 changed production lines, when a fourth production component becomes necessary, or when the fixed panel, Gallery panel, image node schema, media APIs, public rendering, or locale catalogs would need changes.

## Implementation sequence

The follow-up uses one local commit:

Before implementation, verify that the overflow dependency is committed and the worktree contains no unrelated tracked changes. If the dependency is still uncommitted, stop instead of folding it into this follow-up commit.

1. **`refine(admin): align image settings with the editor sidebar`**
   - Add meaningful failing component and end-to-end tests.
   - Refine only the inline `ImageDetailPanel` branch and the content editor's mobile close row.
   - Reuse `FieldHelpLabel`, Kumo `Text`, `Select`, `Tooltip`, `Button`, `Input`, `InputArea`, and `LinkButton`.
   - Update the existing changeset.
   - Run the default implementation rhythm: plan, failing tests, implementation, adversarial review, patch, re-review, checks, scope audit, then local commit.

Required checks are the focused browser tests, the focused Playwright scenario, `pnpm --filter @emdash-cms/admin typecheck`, `pnpm lint:quick` after each edit, targeted formatting, `git diff --check`, and a final `pnpm lint:json | jq '.diagnostics | length'` result of zero.

## Acceptance criteria

- The inline image panel matches the normal content editor sidebar's surface, gutter, heading, field, separator, and action patterns.
- All Option 1 fields remain visible in the specified order.
- Replace image is discoverable and operable with pointer, keyboard, and touch input.
- Display size and Alt text use the native EmDash `FieldHelpLabel` tooltip pattern with the specified localized copy.
- Alignment uses one Kumo Select and persists the same existing attribute values.
- The panel has one close control on mobile, one destructive section, and a stable Cancel/Apply footer.
- Apply, Cancel, replacement, removal, aspect-ratio locking, keyboard shortcuts, and provider preservation behave as specified.
- The panel remains contained and operable in English and Arabic from 200px through 480px and at 200% zoom.
- SectionEditor and Widgets retain their existing outer presentation.
- No database, API, public rendering, query-count, or stored-content contract changes.
- Tests, typecheck, lint, formatting, changeset validation, and manual visual checks pass.

## Unresolved decisions

None. Selecting Option 1 fixes the information architecture, preserves the staged Apply model, and excludes the progressive and asset-inspector directions.

## Implementation authorization

This specification authorizes no implementation or Git/GitHub mutation. Implementation requires explicit approval and a later `$feat-implement` request.
