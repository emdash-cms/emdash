---
title: Choose which heading levels a rich text field offers
type: rfc
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
champion: Daniel Mueller (@danielmlr)
sponsor: null
discussions: []
created: 2026-10-22
---

# Choose which heading levels a rich text field offers

## Summary

This RFC adds a **Heading levels** setting to rich text (Portable Text) fields. A site owner picks which of Heading 1 to 6 editors can create in a field, and the editor stops offering the others wherever a heading can be made: the toolbar, the Turn into and slash menus, Markdown and keyboard shortcuts, and paste. The setting is stored as `headingLevels` in the field's existing `options`. Stored content never changes, the server doesn't reject other levels, and fields without the setting keep all six.

It's an RFC rather than a feature plan because it adds a key to stored field options, gives the schema API a new validation error, reserves the `headingLevels` option name on every field type, and spans `emdash` and `@emdash-cms/admin`.

## Problem and user case

A site that shows the page title as its H1 wants post bodies to start at H2. The rich text editor offers Heading 1 to 6 in every field, so an editor can add a second H1 to a post without knowing it breaks the page outline. Someone asked on Discord whether they can remove H1 from the editor. EmDash has no way to do that yet: plugins can add blocks but can't take built-in ones away, and the six levels are fixed in the admin's editor.

Rendering H1 as H2 on the site hides the symptom, but the editor still shows a big Heading 1 that turns into something else after publishing. The editor itself should only offer the levels the site uses.

## Example

For a blog that never wants H1 in post bodies, the owner opens **Content Types → Posts**, edits the **Content** field, unchecks **Heading 1**, and saves. From then on, in that field:

- The toolbar's heading menu lists Heading 2 to 6.
- The **Turn into** menus (block handle and selection toolbar) and the slash menu leave Heading 1 out, and searching `/h1` finds nothing.
- Typing `# ` at the start of a line stays plain text. `## ` still makes Heading 2.
- Ctrl+Alt+1 (Cmd+Option+1 on a Mac) does nothing.
- Pasting a page with an H1 turns it into Heading 2. The same happens when a section with an H1 is inserted, or when an existing H1 block is duplicated.

Unchecking every level turns headings off for that field, and the toolbar's heading button disappears. That suits short fields, such as an author bio, where a heading never makes sense.

The same setting works in a seed file or through the schema API and MCP tools:

```json title="seed/seed.json"
{
	"slug": "content",
	"label": "Content",
	"type": "portableText",
	"options": { "headingLevels": [2, 3, 4] }
}
```

## Goals

- Let site owners choose, per rich text field in a content type, which heading levels editors can create.
- Keep every way of creating a heading in line with that choice: menus, slash commands, Markdown shortcuts, keyboard shortcuts, paste, inserted sections, and duplicated blocks.
- Never change or hide stored content because of the setting.
- Keep today's behavior for every field that doesn't set it.
- Apply the same setting in the visual editor on the site.

## Non-goals

- Server-side checks that reject or rewrite content with a disallowed heading. See [Editor setting, not a save rule](#editor-setting-not-a-save-rule).
- Rewriting existing content, or a bulk "fix headings" action.
- Changing how headings render on the site.
- Limiting other built-in blocks (lists, quotes, code, tables) or marks. This RFC stays with headings, the one case people have asked about. The option name leaves room for siblings such as `blocks` or `marks` later without renaming anything.
- Rich text outside fields: the section editor and rich text widgets keep all six levels.
- Rich text fields inside block types keep all six levels. A block type's fields accept only the `darkVariant` option today, and widening that is a change of its own.
- A new CLI flag. `emdash schema add-field` doesn't set any field options today; seeds and the API cover this setting.

## Detailed design

### The setting

A rich text field gets a **Heading levels** setting. Site owners pick which of Heading 1 to 6 editors can create in that field. Leaving all six checked, or never touching the setting, keeps today's behavior.

**Stored data.** A new optional key in the field's existing `options` object (`FieldWidgetOptions` in `packages/core/src/schema/types.ts`):

```ts
headingLevels?: Array<1 | 2 | 3 | 4 | 5 | 6>;
```

Order doesn't matter; the admin saves the levels sorted and without duplicates.

**Schema API and MCP.** Creating a field (`POST /_emdash/api/schema/collections/{slug}/fields`) and updating one (`PUT /_emdash/api/schema/collections/{slug}/fields/{fieldSlug}`) already accept any `options` object. Both now return `VALIDATION_ERROR` when `options.headingLevels` is present and isn't an array of distinct whole numbers from 1 to 6. The check runs for every field type, so `headingLevels` becomes a reserved option name. The MCP tools for creating and updating fields describe the key and check it the same way. Other option keys are unchanged.

**Seeds.** Seed validation reports the same error for a malformed `options.headingLevels`, so a typo fails at `emdash seed` instead of being stored.

**Admin.** The field settings dialog for rich text fields gets a **Heading levels** group with six checkboxes. `PortableTextEditor` gets an optional `headingLevels` prop; when it's left out, all six levels are offered, so other callers don't change. The group's labels go through Lingui like the rest of the dialog, and it uses the same logical layout classes, so it works in Arabic and other right-to-left languages.

**Visual editor.** In edit mode, `getEmDashEntry` and `getEmDashCollection` already read the collection's Portable Text fields from `_emdash_fields`, once per request, to tag fields for inline editing. Today that query reads only the field slugs. This RFC adds each field's `options` to it, so the edit metadata that `PortableText.astro` passes to the inline editor carries the allowed levels. Referenced entries are tagged without that query today. With this RFC they use the same cached helper for their own collection.

### Where the setting lives

The setting is stored on the `portableText` field, next to the field's other settings, and it's set in the content type editor, in the seed, or through the schema API and MCP tools. The content model already lives in the database, and keeping every part of it there gives site owners one place to look and one place to change it. There's no site-wide default and no setting in the site's code.

### Editor setting, not a save rule

The setting goes in the field's `options`, which shape the editor. It doesn't go in `validation`, which the server checks on every save. Saves through the admin, API, MCP, CLI, and importers accept any heading level, as they do today.

A save rule doesn't hold up for content that's already stored:

- Rejecting the whole entry means that after an owner unchecks Heading 1, every older post with an H1 fails to save, even for an unrelated typo fix, until someone finds and changes that heading.
- Checking only new or changed blocks means comparing each block with the stored version on every save. Blocks are matched by their `_key`, which API and MCP clients can drop or regenerate, so the check would be least reliable for the writers it's meant to catch. Imports have no stored version to compare with at all.
- Returning a warning instead of an error stops nothing. People in the editor can't create the level anyway, and API and MCP callers rarely show warnings to anyone.
- An importer would either stop partway through a migration or have to change headings without asking.

If a site needs a hard guarantee later, a `validation.headingLevels` rule can be added next to this option without changing it. That proposal would need its own answer for content that's already stored.

### Existing content

The setting never changes content that is already stored. A post that has an H1 from before keeps it, and the editor shows it as Heading 1. While the caret is in that heading, the heading menu and the Turn into menus show Heading 1 as the current choice, the same way they show Heading 4 to 6 today, so editors can see what it is and pick another level. Saving the post keeps the H1 unless someone changes it.

With `headingLevels: []`, the toolbar's heading button is hidden, the menus show no heading entries, and pasted headings become paragraphs. A heading already in the content still shows, and the Turn into menus still list its level while it's selected, so it can be changed to a paragraph.

### Paste and drop

Pasted or dropped content can come from anywhere, so its headings are adjusted on the way in. A heading at a level the field doesn't allow becomes the closest allowed level. When two allowed levels are equally close, it takes the smaller heading, so a tie never makes pasted text more prominent than it was. With headings turned off, pasted headings become paragraphs. Inserted sections and duplicated blocks are new content in the field too, so their headings are adjusted the same way.

Dragging a block to another spot in the same editor keeps its level, also when the drag copies it. Copying and pasting a block is a paste, so it's adjusted, and so is cut and paste inside the same editor.

| Allowed levels | Pasted H1 | Pasted H5 | Pasted H6 |
| -------------- | --------- | --------- | --------- |
| 2, 3, 4, 5, 6  | H2        | H5        | H6        |
| 2, 3, 4        | H2        | H4        | H4        |
| none           | Paragraph | Paragraph | Paragraph |

### Imports and API writes

The WordPress importer, the other importers, and content written through the API, MCP, or CLI store headings exactly as they arrive, because the server doesn't enforce the setting (see [Editor setting, not a save rule](#editor-setting-not-a-save-rule)). Imported content with a disallowed level behaves like the existing content above, so nothing is lost or silently changed during a migration. API and MCP clients that want to follow the setting can read it from the field definition.

### Editing edge cases

- Pressing Enter in the middle of an existing disallowed heading splits it into two headings at that level, because both halves are the heading that was already there. Pressing Enter at its end starts a paragraph, as it does today.
- Undo after a Markdown shortcut works as it does now; a disallowed `# ` never converted, so there's nothing to undo.

### Co-editing

Since [real-time co-editing](./real-time-co-editing.md), the editor's ProseMirror schema lives in a module that the editor and the server's co-editing rooms share. A room builds every rich text field of an entry with that one schema, and a document must be read with the schema that built it. So this setting never changes the schema: it keeps Heading 1 to 6 for every field, and the setting only filters the ways the editor creates a heading.

- Each person's editor applies the setting to their own input: menus, shortcuts, paste, inserted sections, and duplicated blocks. There's no rule that rewrites the document after a change, which would also rewrite other people's edits. Changes from other people in the room arrive as they are, like stored content.
- Everyone in a room works with the same setting. Field options are part of the admin manifest's hash, which rooms compare, so changing a field's heading levels resets open rooms like any other change to a collection's definition, and everyone rejoins with the new levels.
- Rooms don't read the setting, so co-editing needs no server change for it.

## Compatibility and migration

- **Additive, except for one reserved name.** Because the API and seed validation check `options.headingLevels` on every field type, a plugin widget that already stores something else under that name would need to rename it. No default changes.
- **No migration.** `options` is already a stored JSON column, and fields without the key behave exactly as they do now.
- **Versioning.** Minor releases of `emdash` and `@emdash-cms/admin`, each with a changeset.
- **Rollback.** Going back to a release without this feature leaves `headingLevels` in the stored options. Older releases don't read the key, so every field offers all six levels again, and their field settings dialog keeps the key when it saves a field, so upgrading again restores the setting.

## Security and privacy

- **Who can change it.** Creating and updating fields already needs the `schema:manage` permission, or the `schema:write` scope and the Admin role over MCP. No new permission.
- **Untrusted input.** The API and seed validation accept only distinct whole numbers from 1 to 6, and the editor skips anything else it reads. Pasted HTML goes through the same parsing as today; this RFC only changes the level of the headings it produces.
- **Exposure.** The setting reaches the admin with the field's other options, which only signed-in users can read. On the site it's part of the edit-mode metadata, which is rendered only for signed-in Editors and above and never stored in a shared cache. Logged-out pages carry nothing new.
- **Not a guarantee.** Content written through the API, MCP, CLI, or importers can still hold any level, so nothing should rely on the setting for the shape of stored content.

## Performance

- **Admin.** No new requests: field options already arrive with the schema the admin loads. The editor filters its menus against a list of at most six levels.
- **Visual editor.** The existing per-request field query reads one more column. Tagging referenced entries adds at most one query per referenced collection, cached per request, in edit mode only.
- **Logged-out page views.** No change. None of this runs outside edit mode.

## Failure handling

- `headingLevels` missing, or not an array when read by the editor (for example, an older malformed value): the editor offers all six levels.
- Values outside 1 to 6, decimals, or duplicates: rejected by the API and seed validation. If one reaches the editor anyway, it skips the invalid entries, and offers all six levels when none is valid.
- The setting changes while someone has the editor open: the menus, shortcuts, and paste follow the new levels once the admin refetches the schema. Nothing already in the editor changes. With co-editing on, the change resets open rooms, as described in [Co-editing](#co-editing).
- The visual editor can't read the field's options: as today, the query logs a warning, and the inline editor offers all six levels.

## Verification

- Unit tests for reading the setting: missing, empty, unordered, duplicated, and invalid values.
- Unit tests for paste mapping: each row of the table above, ties, and headings off.
- Editor tests with H1 disallowed: the heading menu, slash menu, and Turn into menu leave it out; `# ` stays text; Ctrl+Alt+1 does nothing; an existing H1 still renders as an H1 and shows as the current level; pasting an `<h1>` gives an H2, also after a block drag ended outside the editor; a block dragged inside the editor keeps its level; inserting a section with an H1 and duplicating an H1 block give H2.
- Field settings dialog test: unchecking Heading 1 saves `options.headingLevels: [2, 3, 4, 5, 6]`, checking all six removes the key, and other options on the field are kept.
- API and seed tests for the validation errors, and that a valid value round-trips.
- Visual editor test that the slash menu follows the field's setting.
- Co-editing test with two clients in one room and H1 disallowed: an H1 pasted by one client arrives as an H2 for both, and an existing H1 that a remote edit touches stays an H1.
- A manual pass in light and dark mode, in Arabic, and with keyboard only.

## Rollout and implementation

One implementation pull request after acceptance, covering core (types, API, MCP and seed validation, the visual editor query) and the admin (field settings dialog and editor). No feature flag: a field without the setting behaves as today, so nothing changes for a site until an owner sets it. There are no transitional paths to remove.

## Alternatives

- **An option in `astro.config.mjs`, even as a site-wide default.** It would split the content model between the database and the site's code. The admin couldn't show or change it, seeds and exports wouldn't carry it, and the two places could disagree about the same field.
- **A save rule in `validation`.** See [Editor setting, not a save rule](#editor-setting-not-a-save-rule).
- **Rendering disallowed levels as another level on the site.** The editor would still offer Heading 1 and show text that looks different once published.
- **Passing the allowed levels to the editor's heading extension directly.** TipTap's heading extension then draws a stored H1 as the first allowed level and turns pasted H1s into plain paragraphs. Editors would see existing headings at the wrong level, and pasted headings would lose their structure. The schema is also shared by every field and by the co-editing rooms, so it can't differ per field. The editor keeps all six levels in its schema and filters only the ways of creating a heading.

## Drawbacks

- Only the editor keeps to the setting. Content from the API, MCP, CLI, and importers can still hold any level, so a site that needs a guarantee has to check on its own until a `validation` rule exists.
- Reserving `headingLevels` on every field type can break a plugin widget that already uses that name.
- Every way the editor creates a heading has to respect the setting. A new way added later, such as another menu, has to filter levels too, or it lets disallowed headings back in.

## Open questions

- Should a disallowed heading in existing content get a small visual hint in the editor, or is showing it as the current level in the menus enough?
- When every level is allowed, should the admin store `headingLevels: [1, 2, 3, 4, 5, 6]` or remove the key? This RFC removes it, so the field keeps reading as "default".
- Should the WordPress importer offer to apply the target field's levels during import? This RFC keeps imports exact.
