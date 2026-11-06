---
"@emdash-cms/admin": patch
---

Fixes required file, image and reference fields in the content editor showing "This field is required" (or "Select at least one entry.") as soon as the form opens. The message now appears after the editor tries to save or publish, or when they empty a field they had filled, and is announced to screen readers and linked to the field's button.
