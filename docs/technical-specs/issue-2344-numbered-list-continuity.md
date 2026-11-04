# Numbered-list continuity across blocks

Status: Proposed
Issue: [#2344](https://github.com/emdash-cms/emdash/issues/2344)

## Summary

EmDash currently serializes every ordered-list segment as a flat run of Portable Text blocks. When a paragraph, image, code block, or plugin block separates two runs, both the editor and frontend create a new `<ol>` starting at 1. The editor also drops TipTap's existing `orderedList.attrs.start` during Portable Text conversion.

Add a persistent logical-list identity and base start to numbered Portable Text blocks. The editor will preserve that identity when a list is split, derive each segment's visible start from preceding segments, and expose explicit Continue numbering and Restart numbering actions. The frontend will render each segment as a semantic `<ol start="…">`. This is additive, requires no database migration, and leaves legacy content unchanged until it is edited.

## Goals

- Preserve numbering when arbitrary top-level blocks split an ordered list.
- Recalculate later segment starts after items are inserted, deleted, or moved.
- Preserve explicitly started lists, such as a list beginning at 2.
- Keep independent and nested ordered lists independent.
- Round-trip the behavior through the admin editor, inline visual editor, Portable Text, and frontend rendering.
- Remain backward-compatible with existing Portable Text and third-party renderers.

## Non-goals

- Do not make arbitrary blocks children of a single `<li>`. That requires a future structured rich-list block rather than flat Portable Text.
- Do not rewrite existing content automatically or infer author intent across legacy separated lists.
- Do not store Markdown-only hidden comments or add a database migration.
- Do not synthesize numbered-list continuity metadata during Markdown import or export. Markdown cannot preserve independent logical identities reliably, especially across nested-list boundaries.
- Do not change bullet-list behavior.
- Do not change the Gutenberg importer or its output-only Portable Text types. It remains a legacy metadata-free producer; imported runs acquire identity when subsequently edited in EmDash.

## Data model

Add two optional fields to the core converter, core client, admin editor, and inline editor Portable Text block shapes used by this feature:

```ts
interface PortableTextTextBlock {
	// Existing fields omitted.
	listItem?: "bullet" | "number";
	level?: number;
	listId?: string;
	listStart?: number;
}
```

For numbered blocks:

- `listId` identifies one logical ordered list across non-adjacent segments. Generate IDs with `crypto.randomUUID()` when an author creates or pastes a list.
- `listStart` is the logical list's base start, repeated on every numbered block carrying that `listId`. It is not the later segment's derived start.
- The visible start of each segment is derived from its base plus the number of preceding direct items with the same `listId`.

Apply the same validation contract in each conversion/rendering path. Core code uses one helper for its converters, inline editor, and renderer; the admin keeps a small local equivalent because `emdash` already depends on `@emdash-cms/admin` and the reverse dependency would be circular. Exercise both helpers with the same table of test vectors.

- A valid `listId` is a trimmed, non-empty string of at most 128 characters. Treat any other value as absent and never emit it into HTML.
- A valid `listStart` is an integer from 1 through 2,147,483,647, matching the positive range consistently representable by `HTMLOListElement.start`. The derived `base + precedingDirectItemCount` must remain in that range; otherwise treat that malformed group's effective start as 1 rather than relying on browser-specific clamping.
- One `listId` may belong to only one nesting depth and parent context. If malformed input reuses it in an incompatible context, the first context keeps it and editor normalization deterministically assigns each later context a bounded replacement ID derived from the original ID and structural context; read-only conversion/rendering treats those contexts as separate without mutating stored input.
- Resolve malformed conflicting `listStart` values with a two-pass scan per continuity scope: the first valid value in document order is that scope's canonical base; use 1 if none is valid. Saving rewrites every member to the canonical ID and base.
- Ignore both fields on bullet blocks.

Legacy numbered runs without a valid `listId` remain independent and start at 1. When loaded into an editor, derive a deterministic, document-scoped ID for each contiguous run from its run-start index, level, and first block `_key` when present. Do not use randomness for this fallback: two collaboration peers loading the same legacy value must create identical documents. The next save persists valid metadata. Separated legacy runs are not joined unless the author chooses Continue numbering.

### Numbering algorithm

Use the same document-order algorithm in the editor, converters, and renderer:

1. Canonicalize IDs and bases with the context and two-pass rules above.
2. Build the same logical list tree used by the PT → PM converter, then traverse ordered-list nodes in document order. A segment is a maximal run at one tree position with the same list type, normalized identity, depth, and parent context; a non-list block, different ID/type, or context change ends it. Keep a counter per continuity scope: `listId`, nesting depth, and parent list-item context.
3. The first segment starts at the canonical base. Each later segment starts at `base + precedingDirectItemCount`.
4. Increase the counter by the segment's direct `listItem` child count. Nested list items belong to their own list node and never increment an ancestor or sibling group's counter.

For example, list A with two items, an image, then two more items renders with starts 1 and 3. Inserting an item into its first segment changes the second start to 4 without rewriting a fixed continuation value.

## Editor behavior

Replace StarterKit's ordered-list extension in both editors with package-local EmDash ordered-list extensions that implement the same contract. They cannot import one implementation without creating the existing `emdash` → `@emdash-cms/admin` dependency in reverse, so keep the core-inline and admin implementations small and lock them to the same behavioral fixtures. Retain TipTap's existing `start` attribute and add editor-only `listId` and `listStart` node attributes. Disable only `orderedList` in StarterKit to avoid duplicate node registrations.

The extension owns these behaviors:

- Creating a list with the toolbar, slash command, or `1.` input rule creates a fresh ID with base 1.
- An `N.` input rule creates a fresh ID with base `N`.
- Splitting a list around a paragraph or block preserves the original ID and base on both ordered-list nodes.
- Continue numbering adopts the nearest preceding compatible ordered list's ID and base. Compatibility means the same nesting depth and the same parent `listItem` node; all document-root lists share one root context. Within that context only, rewrite the current segment and every later segment with its old ID, so its existing tail stays together. Disable the action if the selection spans more than one segment, no compatible predecessor exists, or the predecessor already has the same ID. Unrelated nested lists must not be linked.
- Restart numbering assigns a fresh ID and base 1 to the segment containing the selection head and every later segment with its old ID in the same context. Disable it when the selection spans more than one segment. Earlier segments retain the old identity, making the current position the start of a new logical-list tail.
- Adjacent ordered-list nodes with the same ID, base, depth, and parent context merge into one node. Different IDs do not merge.
- A deterministic `appendTransaction` normalizer computes each ordered-list node's effective TipTap `start` attribute using the numbering algorithm and canonicalizes repeated `listStart` values. It must produce no transaction when the document is already normalized.
- Random IDs are created only by user actions and paste handling. Never generate randomness in legacy conversion or the replicated normalizer; collaboration peers must derive the same normalized document.

Copy/paste and movement have different identity semantics:

- A custom ProseMirror clipboard serializer/parser carries source identity, logical base, and the first copied item's displayed ordinal in private `data-emdash-*` attributes in editor clipboard HTML. These attributes are accepted only by the editor parser, remapped before insertion, and never emitted by frontend rendering. This preserves metadata across an HTML clipboard round trip without depending on process-local slice objects.
- A paste remaps every distinct incoming continuity scope to a fresh ID while preserving relationships among segments in that pasted slice. The first pasted segment's effective incoming `start`, not its repeated source `listStart`, becomes the new base and is stamped across the remapped group. Thus copying only a continuation displayed as item 3 pastes an independent list starting at 3 rather than 1. A clipboard slice beginning partway through a segment must likewise use the first copied item's displayed number. External lists without metadata receive fresh IDs per contiguous ordered-list run and preserve a valid HTML/TipTap start as their base.
- An internal drag/move retains IDs only when its destination has the same depth and parent context. A context-changing move remaps the moved scope to a fresh ID whose base is its pre-move effective start; segments left in the source context retain their old ID.
- Undo/redo restores IDs, bases, and derived starts as one user-visible operation.

Expose Continue numbering and Restart numbering in the admin editor's ordered-list controls. Use Kumo components and Lingui for labels, descriptions, tooltips, and accessibility text; use logical Tailwind classes and verify the controls in an RTL locale. Continue is disabled when no compatible preceding list exists. Register the underlying commands in the inline visual editor as well, but do not introduce a second settings UI there; its existing create/split/save flows must still preserve continuity.

## Portable Text conversion

Update all three conversion implementations: the reusable core converters, the admin editor's local converters, and the inline visual editor's local converters.

ProseMirror to Portable Text:

- Read `listId` and logical `listStart` from each ordered-list node.
- If an ordered-list node predates the extension, create a deterministic document-scoped ID from its structural position during serialization and use its valid TipTap `start` as the base when `listStart` is absent. This preserves explicitly started PM documents and makes the failing `start: 2` fixture meaningful.
- Stamp both values on every numbered block produced from that node, including the blocks representing its direct items at the current level.
- When descending into a nested ordered list, use that nested node's own metadata. Never copy the parent's identity into the nested group.
- Do not write the effective TipTap `start` as `listStart`; persist the group base.

Portable Text to ProseMirror:

- Group a numbered run by list type, level/tree position, and canonical `listId`, not merely adjacency and `listItem` type.
- Construct each ordered-list node with `listId`, canonical `listStart`, and the algorithm's effective `start`.
- Use a deterministic key-derived ID for a legacy contiguous run where possible. Preserve its current start-at-1 behavior.
- Preserve existing mixed bullet/number nesting rules and apply numbered metadata only to the ordered nodes at each nesting level.

The first regression test must demonstrate the current failure: a ProseMirror ordered list with `start: 2` loses its start after PM → PT → PM. Make that test fail before implementing the conversion fix.

## Frontend rendering

On the static-render branch of `PortableText.astro`, deep-clone the JSON-shaped value before preprocessing and `groupBlockquoteRuns`; never mutate the caller's array, blocks, nested children, or mark definitions. The preprocessor canonicalizes metadata and counts numbered segments. The edit branch continues to pass the original value to `InlineEditor`, which performs its own conversion.

`astro-portabletext` normally builds an internal `@list` tree by comparing only `level` and `listItem`, which would merge different IDs. Before rendering, build the complete `@list` tree for both bullet and numbered blocks using the caller's requested `listNestingMode` (`html` by default or `direct`) and the toolkit's semantics for that mode, plus one numbered-list rule: two numbered blocks match the same list node only when their canonical scoped identity also matches. Construct identity-aware nodes at every nesting depth, attach the derived effective start directly to each numbered `@list` node, and pass this tree to `astro-portabletext`; because it is already nested, the toolkit does not regroup the children. Adjacent same-ID runs merge, while different IDs remain separate even when nested.

Add an EmDash `OrderedList.astro` component under `emdashComponents.list.number`. It reads the validated effective start from the `@list` node and renders `<ol start={start}>` when the start is not 1, otherwise a normal `<ol>`. It must forward the remaining safe component attributes and slot content. The identity-aware tree is render-only and never enters editor values or serialization.

Component merge order remains EmDash defaults, then plugin components, then user components. A user's `components.list.number` override therefore continues to take priority over `OrderedList.astro`.

Third-party Portable Text renderers may ignore the additive fields and restart separated segments at 1. That is an intentional graceful-degradation boundary; the stored content remains valid Portable Text.

## Markdown boundary

Markdown has no portable logical-list identity. Keep the existing lossy import/export behavior and do not synthesize `listId` or `listStart`. Supporting continuity through Markdown is deferred because nested-list boundaries cannot reliably distinguish an independent root list from a continuation without non-portable metadata.

## Compatibility and rollout

- The fields are optional and additive; no database migration is required.
- Existing content renders and edits as it does today. Authors can repair a separated legacy list with Continue numbering.
- The change performs only in-memory document traversal and adds no database queries or logged-out-route round trips.
- Add patch changesets for `emdash` and `@emdash-cms/admin`. User-facing release notes should say that numbered lists retain numbering across intervening content blocks.

## Test plan

Unit and integration tests must cover:

- PM → PT → PM preserves a list explicitly starting at 2.
- A 1/2/3 list split around a plain paragraph, formatted paragraph, code block, image, and representative plugin block continues at the correct value after save/reload.
- Inserting or deleting an earlier item renumbers every later segment with the same ID.
- A later independent list still starts at 1; adjacent same-ID runs merge and adjacent different-ID root runs stay separate.
- Typed `2.` persists base 2; Continue and Restart produce the expected identities and starts, are disabled for multi-segment selections, and Continue is disabled for an already-linked predecessor.
- Nested ordered lists have independent counters; mixed bullet/number nesting still round-trips without changing structure.
- Copy/paste remaps identities, preserves relationships within the pasted slice, keeps a continuation-only or partial-list copy's displayed start, and does not join the source.
- A same-context drag/move retains identity; a cross-context move gets a fresh identity and preserves its pre-move displayed start without rewriting the source scope.
- Undo/redo and two collaboration peers converge without normalization loops or random-ID divergence.
- Legacy content, missing keys, overlong/empty IDs, IDs reused across root/nested contexts, conflicting bases, non-integer/negative starts, and overflow never throw or emit invalid HTML; editor normalization deterministically repairs incompatible duplicate contexts.
- The admin editor and inline visual editor produce equivalent Portable Text.
- Astro output contains the expected separate `<ol>` elements and later `start` value, separates adjacent different-ID lists at root and nested levels in both `html` and `direct` nesting modes, does not mutate its input, and honors a user `components.list.number` override.
- Markdown import does not synthesize continuity metadata from ambiguous nested and root list sequences.
- New controls are localized, keyboard-accessible, and usable in Arabic/RTL.
- Existing bullet-list, list-nesting, and blockquote-grouping suites remain green; query-count snapshots do not change.

Run the repository-required checks after each implementation commit: `pnpm lint:quick`, the affected Vitest suites, and package `pnpm typecheck`; then run formatting, full relevant tests, changeset validation, and `pnpm lint:json | jq '.diagnostics | length'` before the PR.

## Implementation sequence

The PR should contain three reviewable commits. Each commit must keep types, tests, and runtime code internally consistent.

1. **`fix(portable-text): preserve logical numbered-list identity`**
   - Add the optional block fields, core and admin validation/canonicalization helpers, shared test vectors, and numbering algorithm.
   - Update the core, admin, and inline PM/PT conversion paths.
   - Add the minimal EmDash ordered-list schema extension in both editors, declare `listId`/`listStart`, and disable StarterKit's duplicate ordered-list node so commit 1 can load and save the new attributes without stripping them.
   - Add failing-first converter, legacy, malformed-input, and nesting tests.

2. **`fix(editor): retain numbering when ordered lists are split`**
   - Complete the EmDash ordered-list extension with the deterministic normalizer, identity-aware commands, paste remapping, and context-aware drag behavior in both editors.
   - Add admin Continue/Restart controls with Lingui/Kumo and editor, collaboration, undo/redo, copy/paste, and RTL tests.

3. **`fix(core): render continued ordered-list segments`**
   - Add render preprocessing, identity-aware list-tree construction, and `OrderedList.astro`.
   - Add Astro tests, patch changesets for both packages, and verify query-count snapshots are unchanged.

## Acceptance criteria

The PR is complete when an author can create items 1 and 2, insert any supported top-level block, continue with items 3 and 4, save, reload, edit an earlier item, and see the same correct numbering in the admin editor, inline editor, and rendered Astro page. The stored blocks share one stable `listId` and base, independent lists do not join, legacy content remains readable, and all tests and repository checks above pass.
