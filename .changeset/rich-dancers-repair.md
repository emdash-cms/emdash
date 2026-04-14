---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds synced section references. Editors can now insert a section as a live reference rather than a copy — the section's current content is resolved at render time, so edits to the section propagate automatically to every post that references it.

- New `emdash-section-ref` Portable Text block type rendered by `<SectionRef>` in `emdash/ui`
- New `getSectionById(id)` public API function
- Section picker modal gains an **Insert copy** / **Synced reference** mode toggle
