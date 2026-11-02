---
title: Draft access for trusted editor panels
type: rfc
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
champion: Noah Pham (@khoinguyenpham04)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/3005
created: 2026-10-29
---

# Draft access for trusted editor panels

## Summary

Trusted content-editor panels receive an optional `editorDraft` object. `editorDraft.get()` returns the editor's unsaved field values, slug, SEO title and SEO description, their definitions, a revision, and whether the editor accepts edits. `editorDraft.patch(operations, { expectedRevision })` sets or clears them in the open form. The editor refuses the patch when any of them changed after that revision was read.

A patch marks the form dirty and does not save it. Autosave, saving, publishing, permission checks and server validation then handle the patched values the same way they handle typed ones. The SEO title and description are the exception: the SEO panel saves them itself, as it does typed SEO edits today. In collections with revisions, the first save that sends a patch keeps the previously saved draft in the revision history. The patch operations and field definitions use the types that sandboxed editor panels already use, and both kinds of patch go through the same apply step in the editor.

## Problem and user case

A native plugin can add a React panel to the settings sidebar of the content editor. The panel receives `collection`, `locale` and `entry`, where `entry` is the entry as last saved. The panel can't see edits made since the last save, and it can't change the form.

[Discussion #3005](https://github.com/emdash-cms/emdash/discussions/3005) describes a translation plugin that reads several current text fields, sends them to a translation provider, and puts the results back for the user to review and save. Each locale's entry has its own slug and SEO metadata, so the plugin also needs the slug and the SEO title and description. A tool that generates an excerpt from the body needs the same two operations: read the current values, then put new values into the form without saving.

Today a trusted panel has two workarounds, and both fail:

- Reading `entry` misses every edit made since the last save.
- Writing through the content API changes the stored entry under the open editor. A form without unsaved changes shows the change after it refetches the entry; a form with unsaved changes doesn't, and a rich text field never does. Any save the editor sends before it adopts the new `_rev` is refused as a conflict, and the user is offered **Save anyway**, which overwrites the panel's write.

Sandboxed panels and actions already have this capability ([#3251](https://github.com/emdash-cms/emdash/pull/3251)). With the `admin.editor-draft:read` and `admin.editor-draft:patch` capabilities, the editor sends selected unsaved values when the user invokes the extension. The server validates the patch the plugin returns, the editor shows a before-and-after preview, and accepted changes go into the form, which becomes dirty. Trusted panels have no equivalent.

## Example

A translation panel reads the translatable text fields, translates them, and writes the results back. `translate()` stands for the plugin's own call to its provider.

```ts title="src/admin/translate.ts"
import type { ContentEditorDraft } from "@emdash-cms/admin";

const TEXT_TYPES = new Set(["string", "text"]);

export async function translateDraft(editorDraft: ContentEditorDraft, locale: string) {
	const snapshot = editorDraft.get();
	if (snapshot.readOnly) return null;

	const slugs = snapshot.fieldDefinitions
		.filter((field) => field.translatable && TEXT_TYPES.has(field.type))
		.map((field) => field.slug)
		.filter((slug) => typeof snapshot.fields[slug] === "string");
	if (slugs.length === 0) return null;

	const translated = await translate(
		slugs.map((slug) => snapshot.fields[slug] as string),
		locale,
	);

	return editorDraft.patch(
		slugs.map((slug, index) => ({ op: "set", field: slug, value: translated[index] })),
		{ expectedRevision: snapshot.revision },
	);
}
```

In a collection with SEO, the SEO title and description are `string` and `text` draft fields too, so `translateDraft()` translates them as well. The slug has the `slug` type and is left alone.

The panel component calls `translateDraft(editorDraft, locale)` from a button's click handler and catches errors from `translate()` itself. `translateDraft()` returns `null` without translating when the editor doesn't accept edits or no field needs translating. If the user edited any draft field while the request ran, `patch()` returns `{ ok: false, code: "EDITOR_DRAFT_STALE" }`, nothing changes, and the panel can offer to translate again. If a translated SEO title or description is longer than the `validation.maxLength` in its definition, `patch()` returns `EDITOR_DRAFT_INVALID` and nothing changes. Otherwise the translated values appear in the form, which shows unsaved changes and autosaves on its normal schedule, and the SEO panel saves the SEO values itself.

## Goals

- A trusted panel can read the current unsaved field values, slug, SEO title and SEO description, and their definitions, when it chooses to, without subscribing to changes.
- A trusted panel can set or clear them without saving the entry. SEO values are saved as typed SEO edits are.
- The editor refuses a patch that was computed from values that have since changed, or for a different entry.
- A patch can't put a value into the form that has the wrong shape for its field or that the rich text editor can't load.
- In collections with revisions, the field values and slug saved before a patch stay recoverable after autosave.
- Saving, autosave, publishing, permissions and server validation work as they do today.
- Draft access adds no panel re-renders while the user types.
- Sandboxed and trusted patches use one operation format and one apply step.

## Non-goals

- Notifying panels when the form changes.
- Saving, publishing or scheduling from a panel.
- Reading or patching bylines, taxonomy terms, status, reference fields bound to a relation, or the SEO image, canonical URL and no-index setting.
- Changing when SEO edits are saved. SEO values are stored outside revisions, and a patch saves them the way typing in the SEO panel does today.
- Edits inside a field, such as replacing one block of rich text.
- Draft access for trusted field widgets, content-list columns, dashboard widgets or admin pages.
- Changes to the sandboxed contract. Its capabilities, field selectors, server validation, preview and staleness rule stay as they are; only the apply step it shares with trusted patches changes.

## Detailed design

### Panel context

`ContentEditorPanelContext` gains an optional `editorDraft` property of type `ContentEditorDraft`. The editor passes it to every trusted panel. Trusted panels mount only for saved entries, so `editorDraft` is always present on hosts that implement this RFC and absent on older hosts.

The editor creates one `editorDraft` object per entry it shows. The object keeps its identity while the editor shows that entry, so draft access adds no re-renders. Panels still re-render when the settings sidebar's other inputs change, for example the slug (which typing in the title changes while the slug is still generated from it), the bylines, the publishing state, or the saved entry after a save.

When the editor switches to another entry or locale, including a switch back to an entry it showed before, or unmounts, it retires the object it gave out. A retired object's `get()` returns `{ revision: "", readOnly: true, fields: {}, fieldDefinitions: [] }`, and its `patch()` returns `EDITOR_DRAFT_STALE`. The panel for the new entry receives a new object. A task that a panel started on one entry therefore can't read or patch another entry, or a later visit to the same entry, even if it reads again after the switch.

### Draft fields

The draft covers every field of the collection except:

- fields whose type the editor doesn't support, which also make the whole editor read-only; and
- reference fields bound to a relation, because the editor keeps their selections apart from the field values and sends them in the save request's separate `references` property.

It also covers three values that aren't collection fields, under keys that no field slug can take:

| Key               | Value                                 | Present                 |
| ----------------- | ------------------------------------- | ----------------------- |
| `slug`            | The entry's slug                      | Always                  |
| `seo.title`       | The SEO title in the SEO panel        | In collections with SEO |
| `seo.description` | The meta description in the SEO panel | In collections with SEO |

`slug` is a reserved field slug, and field slugs can't contain a dot. A panel that writes values back through the content API sends these keys as `slug` and `seo`, not in `data`. Bylines and taxonomy terms aren't part of the draft.

### `editorDraft.get()`

`get()` returns a snapshot of the open form:

| Property           | Contents                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revision`         | An opaque string that identifies the draft values the snapshot was taken from.                                                                                          |
| `readOnly`         | `true` when the editor doesn't accept edits, as defined below, or the object is retired.                                                                                |
| `fields`           | A copy of each draft field's current value, made with a JSON round trip, keyed by field slug or key. A field without a value, or an empty slug or SEO value, is `null`. |
| `fieldDefinitions` | One `EditorDraftFieldDefinition` per draft field, with `slug`, `label`, schema `type`, `required`, `translatable` and `validation`.                                     |

The editor doesn't accept edits when it is read-only or a version of the entry is open in the revision view. The editor is read-only when another user holds the edit lock, the user can't edit the entry, or the collection has a field type the editor doesn't support.

`fields` holds values as the editor holds them, so a boolean loaded from storage is `0` or `1` until the user changes it. Because `fields` holds copies, a panel that mutates a snapshot doesn't change the form.

### Revision

A patch succeeds only when the editor shows the same entry and the same draft values as when `get()` returned `expectedRevision`. An autosave completing never changes the revision, because autosave doesn't write the server's response back into the form. A manual save changes the revision only when the server returns values that differ from the ones the form sent, for example a boolean read back as `0` or `1`, or a value that a `content:beforeSave` hook changed. Edits to the bylines, taxonomy terms or other SEO settings don't change it.

After a successful `patch()`, `get()` returns the patched values, even before the editor re-renders.

### `editorDraft.patch(operations, options)`

`patch()` takes an array of the existing `EditorDraftPatchOperation` values, `{ op: "set", field, value }` and `{ op: "clear", field }`, and `{ expectedRevision }`. It returns synchronously and never throws:

```ts
type ContentEditorDraftPatchResult =
	| { ok: true }
	| {
			ok: false;
			code: "EDITOR_DRAFT_STALE" | "EDITOR_DRAFT_READ_ONLY" | "EDITOR_DRAFT_INVALID";
			message: string;
	  };
```

The editor checks the patch in this order and returns the first failure:

1. `EDITOR_DRAFT_STALE` when the object is retired, or the current revision differs from `expectedRevision`.
2. `EDITOR_DRAFT_READ_ONLY` when the editor doesn't accept edits.
3. `EDITOR_DRAFT_INVALID`, with a message that names the operation and field, when:
   - `operations` is not a non-empty array of `set` and `clear` operations;
   - two operations name the same field;
   - an operation names a field that isn't a draft field;
   - an operation clears `slug` or sets it to anything but a non-empty string;
   - a `seo.title` or `seo.description` value is longer than the `maxLength` in its definition;
   - a `set` value can't be serialized as JSON, or doesn't have the shape listed for its field type in [Appendix B](#appendix-b-value-shapes); or
   - the rich text editor can't load a Portable Text value, because the value uses marks it doesn't support or its conversion to the editor's document fails. Fields rendered by a plugin widget skip this check; a field whose widget isn't available is checked like any other rich text field.

A patch applies completely or not at all. A refused patch changes nothing. `message` is English text for developers; a panel shows its own localized text based on `code`.

Appendix B lists the top-level shapes that the server's schema accepts, except that `blocks` items must be objects. Other schema rules, such as required fields, length limits, patterns, select choices, reference targets and slug uniqueness, are checked when the value is saved and reported as they are for a typed value.

### Applying a patch

Trusted and sandboxed patches use one apply step. For collection fields it:

1. writes a JSON copy of each `set` value, or `null` for a `clear`, into the form in one state update, keeping any edit to another field that is waiting to render;
2. marks the form dirty;
3. makes any sandboxed invocation that is still running stale, as a typed edit does;
4. closes the block sidebar if it is open and a patched field is a `portableText` or `blocks` field, and remounts the editor of each patched field; and
5. makes the first save that sends the patched values keep the draft revision it replaces.

The form then autosaves on its normal schedule. The user sees the patched values in the form and can keep, edit or save them like typed changes.

Only trusted patches can name the three extra keys, because sandboxed draft selectors name collection fields. A patch to `slug` goes through the same path as typing in the slug input: the form becomes dirty, a title edit no longer regenerates the slug, autosave sends it, and steps 3 and 5 apply. A patch to `seo.title` or `seo.description` goes into the SEO panel as typing there does. The panel saves it about half a second later in its own request, which doesn't make the form dirty and doesn't count for step 5. When the SEO panel isn't shown, for example while the block sidebar replaces the settings sections, the editor saves the SEO values at once, as the panel does when it closes. SEO values aren't stored in revisions, so that save changes the entry's SEO straight away, on a published entry too, and the revision history can't restore the values it replaced.

A patch that changes both form values and SEO values applies to the form in one step, but is saved in two requests, and either can fail on its own.

The rich text editor builds its document once, when it mounts, and ignores later changes to its value. Today's sandboxed apply step updates the form value but keeps the field's React key, so a patched rich text field goes on showing the old document, and the next keystroke there writes the old document back over the patch. Remounting each patched field fixes this for sandboxed patches as well. Fields the patch doesn't touch keep their editors, cursor position and undo history. The block sidebar edits a block through the rich text editor that opened it, which can be nested in a `blocks` item. A patch to a `portableText` or `blocks` field therefore closes the sidebar before replacing that editor. Other patches leave it open, so unsaved changes in it, such as alt text, stay.

Autosave normally deletes the draft revision it replaces, and a manual save keeps it. The first save that sends a patch's values keeps it even when that save is an autosave. A save that was already in flight when the patch applied carries the earlier values and doesn't count. In collections with revisions, the user can then restore the values saved before the patch from the revision history. Unsaved edits that a patch replaced can't be restored.

### Field definitions

The admin manifest reports each field's editor `kind`. The `slug` and `string` schema types share the `string` kind, so a panel can't tell them apart. Each manifest field descriptor gains the schema `type`, and `fieldDefinitions` uses it. The definitions have the same shape as the ones sandboxed panels receive.

The three extra keys get definitions from the host, with the labels the editor shows for them, translated into the admin's language. `slug` has the `slug` type, `seo.title` the `string` type with a `maxLength` of 200, and `seo.description` the `text` type with a `maxLength` of 500. All three are `translatable` and not `required`.

### Co-editing

The pending real-time co-editing RFC ([#4267](https://github.com/emdash-cms/emdash/pull/4267)) changes two rules while a co-editing room is open. The editor refuses an editor-draft patch only when a field it changes was edited after the values were read, and it applies a rich text patch as one undoable transaction instead of remounting the field. If both proposals are accepted, those room rules apply to trusted patches too. The revision is opaque, so the host can change the staleness rule without changing this API. Whichever proposal is accepted second updates the other proposal in its own design pull request.

## Compatibility and migration

The change is additive: an optional property on `ContentEditorPanelContext`, new exported types, and an optional `type` on manifest field descriptors. It adds no routes, stored data or migrations. SEO edits are saved and stored as they are today.

Existing panels keep working unchanged. A panel that uses `editorDraft` sees `undefined` on an older host. It can hide its draft actions in that case, or declare the minimum `emdash` version in its peer dependencies.

For sandboxed panels and actions, a patch to a rich text field now shows in the editor, and the first save that sends a patch keeps the draft revision it replaces. Their capabilities, field selectors, preview and staleness rule don't change.

## Security and privacy

A trusted panel already runs in the admin bundle with the signed-in user's authority. It can read the page, call the content API and save entries. Draft access gives it no capability it lacks; it replaces reading the DOM or writing behind the editor's back with a path the editor checks. For that reason the host asks for no consent and applies no field selectors or size limits. The sandboxed path has those because it serves plugin code that the site does not trust.

Patches don't bypass authorization. When the user can't edit the entry, `get()` reports `readOnly` and `patch()` refuses, and every save is still authorized on the server.

Unsaved content can be confidential. The documentation tells plugin authors to read and send draft values to an outside service only from an explicit user action, and to tell the user where the content goes.

## Performance

The change affects only the admin. It adds no queries, routes or work on logged-out pages. The manifest grows by one short string per field.

`get()` and `patch()` serialize the draft field values when a panel calls them. Typing does no extra work. The first save that sends a patch keeps one revision that autosave would otherwise delete, and revision pruning applies to it as to any other revision.

## Failure handling

`patch()` reports every failure as a result and never throws, so a panel has one path to handle. A refused patch has changed nothing, so a panel can read again and retry, or tell the user what happened.

An error thrown while a panel renders stays inside the existing panel error boundary. Errors in a panel's event handlers and asynchronous work are the panel's to catch.

A patched value that fails server validation is reported when it is saved, like a typed value.

## Verification

Admin component tests run `ContentEditor` with a trusted panel in a real browser (Vitest browser mode) and check that:

- `get()` returns unsaved values, exact field definitions and `readOnly`, and excludes reference fields bound to a relation;
- `get()` includes `slug`, and `seo.title` and `seo.description` only in a collection with SEO, including SEO text typed less than half a second earlier;
- a `slug` patch shows in the slug input, makes the form dirty and is sent by the next autosave, and a later title edit leaves it unchanged; a `clear` of `slug` returns `EDITOR_DRAFT_INVALID`;
- a `seo.title` patch shows in the SEO panel and is saved by the panel without making the form dirty, and a value over 200 characters returns `EDITOR_DRAFT_INVALID`;
- a `seo.title` patch made while the block sidebar is open is saved, with and without an operation on a `portableText` field, and shows when the settings sections return;
- a patch is stale after an edit to the slug or the SEO title or description;
- `patch()` shows the new values in the form, including a rich text field, marks the form dirty, and doesn't save, and the next autosave sends the patched values and keeps the replaced draft revision;
- a patch made while an autosave of the earlier values is in flight keeps the revision that autosave writes;
- a patch is stale after an edit to any draft field, and a retired object refuses patches after an entry switch, after switching back to the same entry, and after the editor unmounts;
- a patch is not stale after an autosave completes without edits;
- a patch made while an autosave, a manual save or a publish is in flight stays dirty and is saved afterwards;
- a trusted patch made while the sandboxed preview is open makes that preview's Apply report a stale result;
- a patch to a `portableText` or `blocks` field closes an open block sidebar, and a patch to another field leaves it open;
- `patch()` refuses while the editor is read-only or a version is open in the revision view;
- each invalid case, including a value with the wrong shape and rich text the editor can't load, returns `EDITOR_DRAFT_INVALID` and leaves the form unchanged, and a boolean read as `0` or `1` can be written back; and
- typing in a content field doesn't re-render a trusted panel.

A sandboxed regression test applies a patch to a rich text field and checks that the editor shows it. The end-to-end fixture for `e2e/tests/plugin-editor-extensions.spec.ts` already patches the rich text `body` field with the value it read; it changes that value, and the test asserts that the editor shows the new document. A core test checks that manifest field descriptors include `type`.

## Rollout and implementation

One implementation pull request delivers:

- the `editorDraft` property and its exported types;
- the per-entry draft object, revision and checks in `ContentEditor`;
- the shared apply step, with remounting of patched fields and the kept revision;
- the schema `type` on manifest field descriptors;
- the "Content editor panels" section of the React admin extensions guide, and a trusted-panel section in the `creating-plugins` skill's admin UI reference; and
- the tests above and a changeset.

There is no feature flag.

## Alternatives

**Show trusted patches in the host preview.** The sandboxed path asks the user to confirm each patch because the plugin is not trusted. A trusted panel already controls its own UI and can show its own review before calling `patch()`. A mandatory dialog would add a step to every flow without protecting against anything.

**Pass live values to panels.** Passing the form values as props would re-render every panel on every keystroke. The discussion asks for reads on demand.

**Reuse the sandboxed generation counter as the revision.** That counter advances when any save completes, including an autosave. A user who types and then starts a panel action within the 2-second autosave delay would get a stale result whenever the autosave finishes before the action does.

**Refuse a patch only when a field it changes was edited.** A value derived from another field, such as an excerpt generated from the body, would then apply after its source changed. The co-editing RFC accepts that trade-off inside rooms, where edits from other people would otherwise make most patches stale.

**Validate patches fully on the server.** A new route would add a round trip to repeat checks that the save already makes.

**Expose draft access through a hook.** A `useContentEditorDraft()` hook would make plugins import a runtime value from `@emdash-cms/admin` and depend on sharing one React context instance with the host. A prop has neither requirement.

## Drawbacks

- An edit to any draft field while a long panel task runs makes its result stale, and the panel has to read again and redo the work.
- A remounted rich text field starts a new undo history, so the user can't revert a patch with the editor's undo command; they restore the kept revision instead. Remounting also drops a slash-command line that is still open in that field.
- In a collection without revisions, the values from before a patch can't be restored once it has been saved.
- An SEO patch is saved within about half a second and, on a published entry, shows on the site without a publish, as typed SEO edits do today. A translation panel that patches a published entry's SEO changes the live page before the user reviews it.
- SEO saves aren't queued behind the editor's saves, so an SEO patch made while an autosave is in flight can send an outdated entry revision and get the conflict notice, as a typed SEO edit can today. A translation patch makes simultaneous field and SEO saves common.
- `fields` mixes collection fields with the `slug`, `seo.title` and `seo.description` keys, so a panel that sends `fields` to the content API as `data` has to take them out first.
- Validation checks rich text only at the top level of a field. A malformed rich text value nested in a `blocks` item can make the editor throw while rendering. The route then shows its error screen and the pending autosave is cancelled, so the value is never saved, but edits not yet autosaved are lost.
- Validation trusts the converted document. If the rich text editor's schema rejected one, the field would load as an empty document while the form kept the patched value, autosave would save that value, and later typing in the field wouldn't reach the form. Stored content that the schema rejects behaves the same way today.
- The editor keeps two staleness rules: sandboxed results are checked against the generation counter and the saved revision, and trusted patches against the field values.
- A schema violation other than a wrong shape is reported when the value is saved, not when `patch()` runs.
- A faulty trusted panel can overwrite fields without a confirmation step, and autosave saves the result, as with any other bug in trusted admin code.

## Open questions

- A Maintainer sponsor.

## Appendix A: Types

`@emdash-cms/admin` exports these types, and re-exports `EditorDraftFieldDefinition` and `EditorDraftPatchOperation` from `@emdash-cms/blocks`.

```ts
export interface ContentEditorPanelContext {
	collection: string;
	entry: ContentItem;
	locale?: string;
	/** Absent on hosts that predate draft access. */
	editorDraft?: ContentEditorDraft;
}

export interface ContentEditorDraft {
	get(): ContentEditorDraftSnapshot;
	patch(
		operations: readonly EditorDraftPatchOperation[],
		options: { expectedRevision: string },
	): ContentEditorDraftPatchResult;
}

export interface ContentEditorDraftSnapshot {
	revision: string;
	readOnly: boolean;
	fields: Record<string, unknown>;
	fieldDefinitions: EditorDraftFieldDefinition[];
}

export type ContentEditorDraftPatchResult =
	| { ok: true }
	| {
			ok: false;
			code: "EDITOR_DRAFT_STALE" | "EDITOR_DRAFT_READ_ONLY" | "EDITOR_DRAFT_INVALID";
			message: string;
	  };
```

## Appendix B: Value shapes

A `set` value must have the shape listed for its field type. `null` is accepted for every type and has the same effect as `clear`, except for the `slug` key, which takes only a non-empty string. The `seo.title` and `seo.description` keys have the `string` and `text` types.

| Field type                                                         | `set` value                            |
| ------------------------------------------------------------------ | -------------------------------------- |
| `string`, `slug`, `text`, `url`, `datetime`, `select`, `reference` | string                                 |
| `number`                                                           | finite number                          |
| `integer`                                                          | integer                                |
| `boolean`                                                          | `true`, `false`, `0` or `1`            |
| `multiSelect`                                                      | array of strings                       |
| `portableText`                                                     | array of objects with a string `_type` |
| `repeater`, `blocks`                                               | array of objects                       |
| `image`, `file`                                                    | object that is not an array            |
| `json`                                                             | any JSON value                         |

## Appendix C: Implementation notes

- **Draft object.** The editor creates the object with `useMemo` keyed by its entry identity (`collection`, entry ID and locale), from callbacks that read refs. The object records the editor's entry-switch count and a random ID. It is retired for good once the switch count changes, which happens on every switch, including a switch back to the same entry, or when the editor unmounts. The editor advances the switch count while rendering, so an old object never reads the new entry's values.
- **Revision.** Each `get()` and `patch()` serializes the draft field values in field order, then the slug and SEO values, and compares the result with the previous call on the same object. When they differ, a counter advances. The revision is the object's random ID followed by that counter. The comparison derives the revision from the values themselves, so no edit path has to remember to advance it.
- **Synchronous reads after a patch.** The apply step writes the patched values into the editor's form, slug and SEO references before React re-renders, so a `get()` in the same task sees them.
- **Remounting.** The field key gains a per-field counter that the apply step advances for each patched field.
- **Kept revision.** The editor counts applied patches that change a collection field or the slug. Each save records the count when it is sent, and a successful save raises the kept count to the count it recorded. While the patch count is above the kept count, the autosave input asks the router to keep the replaced revision. The router then sends `skipRevision: false` instead of `true`, and `withAutosavedDraft()` in `lib/revision-list-cache.ts` leaves that revision in the cached revision lists instead of removing it. On an entry switch, the kept count is set to the patch count, so both counts only grow and a late save can't overtake a newer patch.
- **SEO values.** The editor keeps the SEO title and description for the shown entry in a ref, set from the saved entry on each entry switch. The SEO panel writes to that ref whenever its title or description changes, and starts from it when it mounts, treating the ref's values as already sent, so the ref outlives the panel. A patch writes the ref and, when the panel is mounted, updates the panel through the same function as typing; otherwise it sends the SEO save at once through the existing SEO change handler.
- **Rich text check.** Validation calls `findUnsupportedPortableTextMarks()` and then `portableTextToProsemirror()` with the plugin block types the rich text editor uses when it mounts. The conversion function is exported today only for tests, as `_portableTextToProsemirror`, and becomes a named export. Any error from either function rejects the value.
- **Bound reference fields.** A `reference` field is bound when its `validation` names both a `relation` and a `targetCollection`, the same condition the field renderer uses to show the relation picker.
- **Manifest `type`.** The runtime builds every manifest field from the database, where the schema type is known. The exported `generateManifest()` also derives descriptors from Zod schemas, which have no schema type; those descriptors omit `type`, and the editor leaves such fields out of the draft.
