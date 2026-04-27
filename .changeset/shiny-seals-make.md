---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the `file` field type rendering as a plain text input in the content editor. Adds a `FileFieldRenderer` that opens the media picker (with mime filter disabled) so any file type can be attached. Also adds a `hideUrlInput` prop to `MediaPickerModal` so non-image pickers can hide the image-specific "Insert from URL" input.

Aligns the Zod schema and generated TypeScript types for `image` and `file` fields with the shape the admin actually stores: `provider?`, `meta?` (for both), and `previewUrl?` (for image). Previously these fields were stripped on validation and missing from generated types, so site code could not reliably resolve local media URLs from `meta.storageKey`.
