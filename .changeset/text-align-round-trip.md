---
"emdash": patch
---

fix(core/converters): persist text alignment from rich-text editor through ProseMirror ↔ Portable Text round-trip (#1201)

`prosemirrorToPortableText` now reads `node.attrs.textAlign` for paragraphs and headings and forwards it into the Portable Text block. `portableTextToProsemirror` restores it back into ProseMirror node attrs. The `PortableTextTextBlock` type gained an optional `textAlign?: "left" | "center" | "right" | "justify"` field. Left alignment is not persisted (it is TipTap's default and would bloat existing content).
