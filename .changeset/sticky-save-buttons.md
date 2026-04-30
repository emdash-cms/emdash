---
"@emdash-cms/admin": minor
---

Adds consistently-placed sticky Save buttons across editor pages so unsaved changes are always visible. The Content editor, Section editor, Content Type editor, and Settings sub-pages (General, SEO, Social Links) now render their primary save action in a sticky top-right header that stays visible while users scroll long forms. The existing bottom-of-form save buttons are preserved so keyboard and screen-reader users still hit a save action as the last interactive control on the page (DOM order is unchanged). Introduces a shared `EditorHeader` component for editor pages that want the same sticky-header pattern. Fixes #233.
