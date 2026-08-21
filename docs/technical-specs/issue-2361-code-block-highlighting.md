# Editor code-block syntax highlighting and theming

Status: Proposed
Issue: [#2361](https://github.com/emdash-cms/emdash/issues/2361)
Base: `origin/main` at `353ff4fd2e052e1a60ec31b92bdcd6024401997a`

## Summary

Code blocks in the admin Portable Text editor and inline visual editor store a language but render the code as one unhighlighted text node. The admin's current code foreground and background invert incorrectly across appearances, and the inline language controls hard-code light colors.

Replace the plain TipTap code-block extension in both editors with TipTap's Lowlight extension. Register the bounded Lowlight common grammar set plus Dockerfile, disable language auto-detection, and preserve the existing React node views, language picker, Portable Text shape, and public renderer. Apply a scoped syntax palette in the admin and expose equivalent CSS variables for sites to theme the inline visual editor.

## Goals

- Highlight supported code using the language stored on the code block.
- Keep code, the language picker, and its controls readable in the admin's light and dark appearances.
- Give the inline visual editor accessible system light/dark defaults and a documented site-level override contract.
- Update highlighting immediately when an editor changes the language or code.
- Preserve stored Portable Text and all existing language-picker behavior.

## Non-goals

- Do not add highlighting to `packages/core/src/components/Code.astro` or any other public, logged-out rendering path.
- Do not change the curated language list or add Zig or Lua entries.
- Do not add a Shiki integration or guarantee highlighting for every free-form language value.
- Do not add Tab indentation. Issue [#2594](https://github.com/emdash-cms/emdash/issues/2594) tracks that behavior.
- Do not change View Live, preview reliability, edit-mode persistence, or the welcome dialog. Issues [#2595](https://github.com/emdash-cms/emdash/issues/2595) and [#2596](https://github.com/emdash-cms/emdash/issues/2596) cover those defects.
- Do not refactor the duplicated admin and inline language pickers or introduce a shared editor package.
- Do not change editor commands, code-block serialization, or the Portable Text schema.

## Approved product decisions

- A registered language is highlighted. An absent, `plaintext`, or unsupported language remains plain text.
- The highlighter never guesses a language.
- The admin follows its `data-mode` light/dark appearance.
- The inline editor follows the browser's system appearance by default. A site with its own explicit theme switch sets the documented CSS variables in that theme's selector.
- Public code-block rendering and language-list expansion remain separate work.

No unresolved product decisions remain.

## Verified current behavior

The verified source tree and browser reproduction establish the following behavior:

- `packages/admin/src/components/editor/CodeBlockNode.tsx` extends `@tiptap/extension-code-block` and renders `<pre><NodeViewContent as="code" /></pre>`. The selected language is stored on `node.attrs.language`, but no tokenizer creates token spans.
- `packages/core/src/components/inline-code-block.tsx` repeats the same plain extension and node-view structure for visual editing.
- Both editors disable StarterKit's code block before registering their package-local replacement. The existing extension name, commands, backtick input rule, editable content DOM, and language attribute therefore remain the compatibility boundary.
- The admin maps prose code text to `--text-color-kumo-subtle` and the code background to `--color-kumo-contrast`. These roles invert across appearances and produce low-contrast dark-on-dark or gray-on-light combinations.
- The inline node view hard-codes light control surfaces. Its surrounding inline editor has some system-dark rules, but none cover the code block or language picker.
- Admin and core conversion paths already round-trip only `code` and `language`. Decoration markup is not part of the ProseMirror document and must not enter Portable Text.
- `codeBlockLanguages.ts` contains 33 suggestions and accepts sanitized free-form input.
- Lowlight's common set supports most of the curated identifiers or aliases but omits Dockerfile. Highlight.js has no registered Astro, MDX, Svelte, Vue, or Zig grammar in that set.
- TipTap 3.20.0 provides `@tiptap/extension-code-block-lowlight` 3.20.0. Its decoration plugin recalculates token spans for code changes, language-attribute changes, node insertion/removal, and collaboration transactions that replace a complete code block.
- TipTap's plugin calls `highlightAuto` when it cannot resolve a language. EmDash must override that fallback because auto-detection conflicts with the approved plain-text behavior.
- Existing admin tests cover the schema name, commands, and language attribute but do not assert rendered token spans. Existing inline visual-editing end-to-end tests provide the appropriate real-browser surface for the core editor.

## Technical design

### Dependencies and grammar bound

Add catalog entries matching the current TipTap line for:

- `@tiptap/extension-code-block-lowlight` `3.20.0`
- `lowlight` `^3.3.0`
- `highlight.js` `11.11.2`

Declare all three as direct runtime dependencies of `@emdash-cms/admin` and `emdash`. `highlight.js` is a peer of TipTap's Lowlight extension and a dependency of Lowlight; declaring it directly makes resolution explicit under pnpm's peer rules.

Each editor module imports `common` and `createLowlight` from `lowlight`, creates one package-local instance from the exported `common` grammar map, registers `highlight.js/lib/languages/dockerfile`, and reuses that instance for every editor on the page. Do not use Lowlight's exported `all` grammar map, dynamically fetch grammars, or create one instance per component render.

The common grammar map also registers languages that are not picker suggestions. A free-form value such as `lua` is highlighted because the configured instance registers it. "Unsupported" means absent from that instance, not absent from the picker. Astro, MDX, Svelte, Vue, Zig, and other unregistered values take the approved plain-text fallback.

The package-local object passed to TipTap must expose the Lowlight methods that TipTap validates:

- Delegate `listLanguages` and `registered` to the configured Lowlight instance.
- Implement `highlight` as a guarded wrapper: call the configured grammar only when the package-local Lowlight instance registers the language; otherwise highlight as `plaintext`.
- Implement `highlightAuto` by highlighting as `plaintext` instead of detecting a language.
- Configure TipTap's `defaultLanguage` as `plaintext` so a missing language also takes the plain path.

This facade is required even though most curated languages are registered. TipTap also checks its own Highlight.js core before it calls the supplied Lowlight object; another bundle consumer could register a grammar there that is absent from EmDash's package-local instance. Guarding both `highlight` and `highlightAuto` keeps unsupported strings plain and prevents that cross-consumer state from causing `lowlight.highlight()` to throw.

TipTap's upstream plugin assumes `node.attrs.language` is a string before it checks registration. At each editor's Portable Text-to-ProseMirror boundary, pass the language through only when it is a non-empty string; otherwise set the node attribute to `null`. This guard matches the declared `language?: string` contract and prevents malformed stored values such as numbers or objects from crashing decoration setup. It does not normalize, replace, or otherwise rewrite valid string values.

### Admin editor

Change `CodeBlockExtension` to extend and configure `CodeBlockLowlight` while keeping its extension name `codeBlock` and the existing `ReactNodeViewRenderer(CodeBlockNodeView)`. ProseMirror decorations then render scoped `hljs-*` spans inside the existing `NodeViewContent`; the language picker, popover portal, commands, keyboard behavior, and content DOM do not change.

Add syntax rules under `.emdash-code-block` in `packages/admin/src/styles.css`. Define role-based variables with the light values from the measured palette below, then override those variables under `[data-mode="dark"] .emdash-code-block`. The admin's explicit theme toggle is driven by `data-mode`; `light-dark()` alone would follow `color-scheme` and could remain on the operating-system appearance. Use the role variables at every declaration site rather than applying raw palette values directly. Do not import a global Highlight.js stylesheet: global `.hljs-*` rules could restyle plugin UI or consumer content, and an unscoped theme would not follow Kumo's appearance state reliably.

Map Highlight.js classes into these roles:

- Base code uses `background`, `foreground`, and `border`.
- Comments and quotes use `muted`.
- Keywords, literals, selectors, sections, links, and deletions use `keyword`.
- Strings, attributes, symbols, bullets, and additions use `string`.
- Numbers and metadata use `number`.
- Titles, names, types, built-ins, and selector identifiers use `title`.
- Any unlisted token inherits `foreground`.

Keep the language trigger and popover on Kumo surface, text, border, and focus tokens. Syntax colors must not be reused for interactive, success, warning, or destructive UI meaning.

### Inline visual editor

Change `InlineCodeBlockExtension` to use the same bounded Lowlight configuration and plain-text fallback. Keep the current node view, language datalist, free-form normalization, focus behavior, logical `insetInlineEnd`, and save flow.

Move code-block and language-control color declarations out of hard-coded inline values and into the existing style block emitted by `InlinePortableTextEditor.tsx`. Scope every rule to `.emdash-inline-code-block` or `.emdash-code-block` inside `.emdash-inline-editor` so the editor cannot restyle the host site's static code blocks.

The inline editor exposes the following additive CSS custom properties:

| Property                                  | Role                                         |
| ----------------------------------------- | -------------------------------------------- |
| `--emdash-inline-code-background`         | Code-block surface                           |
| `--emdash-inline-code-foreground`         | Untokenized code and fallback text           |
| `--emdash-inline-code-muted`              | Comments and quotes                          |
| `--emdash-inline-code-keyword`            | Keywords, literals, selectors, and deletions |
| `--emdash-inline-code-string`             | Strings, attributes, symbols, and additions  |
| `--emdash-inline-code-number`             | Numbers and metadata                         |
| `--emdash-inline-code-title`              | Titles, names, types, and built-ins          |
| `--emdash-inline-code-border`             | Code-block and control boundary              |
| `--emdash-inline-code-control-background` | Language control surface                     |
| `--emdash-inline-code-control-foreground` | Language control text and icons              |
| `--emdash-inline-code-focus`              | Keyboard focus indicator                     |

Use each property through `var(--property, fallback)` rather than defining it on the component. An inherited site value must therefore override the fallback. Preserve compatibility with the existing `--emdash-inline-bg` customization by using it as the secondary fallback for the control surface.

Use this measured fallback palette:

| Role               | Light     | Dark      |
| ------------------ | --------- | --------- |
| Background         | `#f6f8fa` | `#0d1117` |
| Foreground         | `#24292f` | `#f0f3f6` |
| Muted              | `#57606a` | `#c9d1d9` |
| Keyword            | `#b8172a` | `#ffbcb5` |
| String             | `#0a3069` | `#b9ddff` |
| Number             | `#0550ae` | `#a8d5ff` |
| Title              | `#7545c7` | `#e5ccff` |
| Border             | `#7d8590` | `#6e7681` |
| Control background | `#ffffff` | `#161b22` |
| Control foreground | `#24292f` | `#f0f3f6` |
| Focus              | `#0550ae` | `#a8d5ff` |

Use the same values for the admin's internal syntax role variables. The syntax and control foregrounds measure at least APCA `|Lc| 75` and WCAG 2 `4.5:1` against their assigned backgrounds. Borders and focus indicators measure at least `3:1`. Recalculate the rendered pairs if implementation details introduce alpha, blending, or a different surface.

Provide the light values as normal fallbacks and the dark values inside `@media (prefers-color-scheme: dark)`. A host site that switches appearance independently of the operating system overrides the variables under its own theme selector. Theme changes update CSS only; they must not rebuild the editor, recreate the node view, alter selection, or save content.

### Documentation contract

Add a short subsection to the Visual Editing section of `docs/src/content/docs/guides/querying-content.mdx`. State that inline code blocks follow the system appearance by default, list the override variables, and show one light/dark site-theme example using the site's existing selectors. The documentation must distinguish inline editing from public `Code.astro` rendering.

Do not change the existing "Code blocks - With syntax highlighting" line in the admin content guide. The implementation makes that editor-specific statement accurate.

## State and failure behavior

The editor derives all highlighting from current ProseMirror state:

| State                                                                                          | Result                                                                                 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Supported stored language                                                                      | Lowlight adds token decorations for that grammar.                                      |
| `plaintext`, empty, or missing language                                                        | Code stays readable with base foreground and no token colors.                          |
| Unsupported string language                                                                    | The stored value and picker label remain intact; code uses the plain-text fallback.    |
| Invalid non-string language                                                                    | The editor treats it as missing and saves it as absent on the next content update.     |
| Language changed in the picker                                                                 | The attribute transaction replaces the decorations without changing code or selection. |
| Code edited, pasted, undone, or redone locally, or replaced completely by a remote transaction | Decorations are derived again from the resulting document state.                       |
| Theme or site variables changed                                                                | Existing token spans receive new CSS values without a document transaction or save.    |

Lowlight runs locally and synchronously. It performs no network request, inserts no HTML string, and stores no highlighted markup. A refresh reconstructs the same decorations from `code` and `language`.

## Compatibility, security, and cost

- Portable Text remains `{ _type: "code", code, language? }`. No migration, API change, or database query is required.
- Existing unsupported string languages, free-form values, language aliases, and code content continue to save and reload unchanged. Non-string language values are outside the published shape and are omitted after an editor save.
- Lowlight returns a syntax tree that TipTap converts to ProseMirror decorations. Code remains text content, so author input is not interpreted as HTML.
- No authorization, CSRF, preview-token, or public-route behavior changes.
- The anonymous rendering branch of `PortableText.astro` and `Code.astro` stays unchanged. The highlighter executes only in the admin or hydrated inline editor.
- Highlighting work is proportional to the total code-block text TipTap recalculates for a qualifying transaction. Keep the grammar set bounded to `common` plus Dockerfile and verify a document containing a 20,000-character code block remains responsive while typing, changing language, and switching theme.
- Record minified and gzip sizes for the admin JavaScript and the inline-editor client chunk before and after implementation. Using Lowlight's `all` grammar map, adding runtime grammar requests, or adding a new asset to logged-out page requests is a blocking scope change.

## Accessibility, localization, RTL, and responsive behavior

- Every syntax foreground must meet APCA `|Lc| 75` and WCAG 2 `4.5:1` against its code background in both appearances. Code meaning cannot depend on color because the source characters remain visible without token styles.
- The language trigger, input, Apply, and Cancel controls retain their existing names, tab order, focus behavior, and keyboard operation. Their text meets `4.5:1`; borders and focus indicators meet `3:1`.
- The code block retains horizontal scrolling for long lines. The control remains at the logical inline end and must not cover editable code at desktop or narrow widths.
- Existing logical positioning remains RTL-safe. Verify the admin in Arabic and an inline editor under `dir="rtl"`; do not mirror code characters or directional icons that have no directional meaning.
- No user-facing strings are added to the admin, so no Lingui catalog source changes are required. Do not include generated `messages.po` files.

## Tests and manual verification

Follow the repository bug workflow for each commit: add a meaningful failing test, implement the behavior, and rerun the narrow suite.

### Automated tests

- Preserve the schema-name, `toggleCodeBlock`, and language-attribute assertions in `packages/admin/tests/editor/CodeBlockNode.test.ts`.
- Extend `packages/admin/tests/editor/PortableTextEditor.test.tsx` through its existing browser render helper. A JavaScript block must render grammar-specific `hljs-*` token spans; changing its language must update the token classes; `plaintext`, Astro, Zig, and an arbitrary free-form value must render no syntax token spans. Verify editor JSON contains only the original code and language rather than decoration markup.
- Add a converter-boundary regression using a non-string language. Both editors must load without throwing, render plain code, and omit the invalid value from their next serialized result.
- Add one published `post-with-code` entry in `e2e/global-setup.ts`. Give it separate JavaScript and Astro blocks so supported and unsupported behavior can be observed without changing or saving shared fixture content.
- Add an admin end-to-end scenario that opens the seeded post, verifies token spans, switches between light and dark appearances, and measures every rendered syntax/control foreground against its actual computed background. The node view, editor selection, and saved value must survive the switch.
- Add `e2e/tests/code-block-highlighting.spec.ts`. In edit mode, verify supported token spans, plain fallback for the Astro block, system-light and system-dark fallback colors, and live site-variable overrides without recreating the editor or issuing a content update request.
- Verify long lines scroll horizontally, controls remain reachable by keyboard at a narrow viewport, and logical-end positioning works under `dir="rtl"`.
- Assert the public page outside edit mode still emits the existing `language-{id}` classes and no `hljs-*` token markup. This guards the explicit public-rendering exclusion.

Do not add tests that only assert a dependency literal, copied palette value, CSS class string, or mock return value. The tests must fail when tokenization, fallback behavior, theme response, contrast, storage integrity, or editor interaction regresses.

### Manual scenarios

- In the admin, type and edit JavaScript, HTML, CSS, and Dockerfile blocks. Change each language and switch light, dark, and system appearances.
- In inline visual editing, repeat a supported language and an unsupported value under system light/dark, then under a site-defined explicit theme override.
- Type continuously in a 20,000-character code block, undo and redo, change its language, and confirm the caret does not jump and the picker does not close unexpectedly.
- Save and reload from both editors. Confirm code and language are unchanged and highlighting returns.
- Check the language trigger, input, Apply, and Cancel controls with keyboard-only navigation in left-to-right and right-to-left layouts.

## Expected files and line budget

Expected production and contract files:

- `pnpm-workspace.yaml`
- `pnpm-lock.yaml` (generated; excluded from the hand-written line budget)
- `packages/admin/package.json`
- `packages/admin/src/components/PortableTextEditor.tsx`
- `packages/admin/src/components/editor/CodeBlockNode.tsx`
- `packages/admin/src/styles.css`
- `packages/core/package.json`
- `packages/core/src/components/inline-code-block.tsx`
- `packages/core/src/components/InlinePortableTextEditor.tsx`
- `docs/src/content/docs/guides/querying-content.mdx`
- one changeset covering `@emdash-cms/admin` and `emdash`

Expected test files:

- `packages/admin/tests/editor/CodeBlockNode.test.ts`
- `packages/admin/tests/editor/PortableTextEditor.test.tsx`
- `packages/core/tests/unit/components/inline-portable-text-code-block.test.ts`
- `e2e/global-setup.ts`
- `e2e/tests/code-block-highlighting.spec.ts`

Projected hand-written changes are 150-230 production lines, 240-360 test lines, and 35-60 documentation/changeset lines. More than 275 production lines or 400 test lines requires a scope audit. More than 350 production lines or 500 test lines, a new workspace package, a custom ProseMirror highlighting plugin, Shiki, public-renderer work, or language-list changes blocks implementation until the specification is revised and approved.

## Implementation sequence

Implement this specification in two reviewable commits. Use the sequence `plan -> meaningful failing tests -> implementation -> adversarial review -> patch -> re-review -> checks -> scope audit -> local commit` for each commit.

### Commit 1: Highlight and theme admin code blocks

Responsibility: complete the bug fix for the admin Portable Text editor.

- Add the catalog and admin runtime dependencies.
- Add the bounded Lowlight instance and plain-text fallback to `CodeBlockExtension`.
- Guard the admin Portable Text-to-ProseMirror language boundary against non-string values.
- Add scoped admin syntax roles and light/dark values.
- Add failing-first Portable Text editor browser tests for supported highlighting, unsupported fallback, language changes, and storage integrity.
- Add a malformed-language boundary regression to the admin Portable Text editor suite.
- Add the admin light/dark contrast and interaction E2E scenario.

Projected lines: 70-110 production and 110-170 tests. The commit excludes inline-editor source, public rendering, documentation, and language-list changes.

### Commit 2: Match inline visual editing and publish the contract

Responsibility: provide equivalent highlighting and theme behavior in the inline visual editor.

- Add the core runtime dependencies and package-local bounded Lowlight instance.
- Guard the inline Portable Text-to-ProseMirror language boundary against non-string values.
- Move inline code-block/control colors to scoped CSS variables with system fallbacks.
- Add an inline converter unit test for valid, unsupported, and invalid language values.
- Add failing-first inline E2E coverage for tokenization, fallback, overrides, RTL, narrow layout, persistence, and the unchanged public renderer.
- Document the inline theme variables in the Visual Editing guide.
- Add one patch changeset for `@emdash-cms/admin` and `emdash`: "Fixes code blocks in the admin and inline visual editors so supported languages are syntax-highlighted and readable in light and dark appearances."
- Record editor bundle deltas and run the final checks.

Projected lines: 80-120 production, 130-190 tests, and 35-60 documentation/changeset lines. The commit depends on the catalog entries from commit 1 and excludes public highlighting, grammar expansion, and the other split issues.

## Verification gates

Run after each implementation edit:

- `pnpm lint:quick`
- the affected admin browser or E2E test
- `pnpm typecheck` for package changes
- `pnpm typecheck:demos` when the inline editor or E2E fixture changes

Run before the pull request:

- both focused code-block test suites
- the existing Portable Text editor and visual-editing suites
- `pnpm exec playwright test e2e/tests/code-block-highlighting.spec.ts`
- `EMDASH_E2E_TARGET=cloudflare pnpm exec playwright test e2e/tests/code-block-highlighting.spec.ts`
- `pnpm format`
- `pnpm lint:json | jq '.diagnostics | length'`
- `pnpm --dir docs build`
- `git diff --check`
- changeset validation and package builds for `@emdash-cms/admin` and `emdash`

The clean-worktree preflight `pnpm lint:json` did not return a result because pnpm did not complete in the dependency-free spec worktree. Establish and record a clean baseline after dependencies are available; do not report the lint gate as passing until the command returns zero diagnostics.

## Acceptance criteria

- A supported language produces grammar-specific token spans in the admin and inline visual editors.
- Missing, `plaintext`, and unsupported languages remain plain without errors or auto-detection.
- Editing code or changing the language updates highlighting without moving the caret, closing the picker, changing stored content, or requiring a reload.
- Admin code, syntax tokens, language controls, borders, and focus indicators meet the specified contrast in light and dark appearances and update on theme changes.
- Inline code blocks meet the same visual contract under system light/dark defaults and under documented site CSS-variable overrides.
- The language picker remains keyboard-accessible, localized in the admin, RTL-safe, and usable at narrow widths.
- Saving and reloading through either editor preserves the exact code and language and reconstructs highlighting.
- Public `Code.astro` output, the curated language list, Portable Text, database/API behavior, and anonymous route/query counts remain unchanged.
- Bundle measurements confirm that only editor assets grow and that the implementation uses Lowlight's `common` grammar map plus Dockerfile rather than all grammars.
- Required tests, type checks, lint, formatting, package builds, documentation build, and changeset validation pass.

## Authority

This document authorizes no implementation, commit, push, pull request, rebase, merge, issue update, or other Git/GitHub mutation. Implementation requires a separate approved `$feat-implement` request.
