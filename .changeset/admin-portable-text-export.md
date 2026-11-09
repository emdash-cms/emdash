---
"@emdash-cms/admin": minor
---

Adds three exports for EmDash's own packages. `@emdash-cms/admin/portable-text` provides the editor's ProseMirror schema (`portableTextSchema`, `portableTextExtensions`) and its Portable Text converters (`portableTextToProsemirror`, `prosemirrorToPortableText`) to server code, and it loads without a DOM or Yjs. `@emdash-cms/admin/portable-text-y-sync` provides `PortableTextYSync`, the editor's fixes for syncing that schema through Yjs. `@emdash-cms/admin/video-block` holds the editor's rules for video blocks, which core's converters now use too.
