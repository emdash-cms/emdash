---
"@emdash-cms/admin": patch
---

Replaces 20 raw `<input type="checkbox">` elements across the admin UI with Kumo's `Switch` and `Checkbox` components. Single-boolean toggles (SEO, Enable comments, Required, etc.) become `Switch`; multi-select / list-context checkboxes (collection multi-select, term tree nodes) become `Checkbox`. Drops manual styling and label markup that duplicated what the Kumo components provide built-in.
