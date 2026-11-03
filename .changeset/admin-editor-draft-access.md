---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds draft access for trusted content editor panels. A native plugin's panel receives `editorDraft` beside `entry`. `editorDraft.get()` reads the values open in the editor, including unsaved changes: the field values, the slug, and the SEO title and meta description, with their definitions and a revision. `editorDraft.patch(operations, { expectedRevision })` sets or clears them in the form without saving the entry. The editor refuses the patch when any of those values changed after the revision was read. A translation or excerpt panel can therefore read the current draft and put its results back for the user to review, without overwriting edits made while it worked. The SEO panel saves patched SEO values the way it saves typed ones, so they take effect at once. `editorDraft` is `undefined` on older versions. The React admin extensions guide covers the rules and has an example.

Draft patches from sandboxed editor panels and actions (`admin.editor-draft:patch`) change too:

- A patched rich text field shows the patched document. Before, it kept showing the old document, and the next keystroke there wrote the old document back over the patch.
- In collections with revisions, the first save that includes a patch keeps the draft revision it replaces, autosaves included, so the values from before the patch can be restored.
- A sandboxed patch with rich text that the editor can't load is refused with the "Plugin changes were not applied" notice, and the form is left unchanged.

Field descriptors in the admin manifest include the field's schema `type`, which tells apart types that share an editor `kind`, such as `slug` and `string`.
