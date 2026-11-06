---
"@emdash-cms/admin": minor
---

Adds two exports for EmDash's own server packages. `@emdash-cms/admin/portable-text` provides the editor's ProseMirror schema (`portableTextSchema`, `portableTextExtensions`) and its Portable Text converters (`portableTextToProsemirror`, `prosemirrorToPortableText`), and it loads without a DOM. `@emdash-cms/admin/video-block` holds the editor's rules for video blocks, which core's converters now use too.
