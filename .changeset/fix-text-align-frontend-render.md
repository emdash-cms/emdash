---
"emdash": patch
---

fix: render text alignment from rich-text editor end-to-end (#1201)

The previous fix in `text-align-round-trip` patched only the `packages/core/src/content/converters/` pair but the rich-text editor saves through two other ProseMirror ↔ Portable Text converters that each carried their own copy of the same logic — so reporter and maintainer kept seeing alignment dropped on save:

- `packages/admin/src/components/PortableTextEditor.tsx` (admin save path)
- `packages/core/src/components/InlinePortableTextEditor.tsx` (in-page inline editing)

Both now forward `node.attrs?.textAlign` for paragraphs and headings (only `center`, `right`, `justify` — `left` is the editor default and is omitted so existing content stays byte-identical) and restore it on the reverse path. Each editor's local `PortableTextTextBlock` interface gained the `textAlign?: "left" | "center" | "right" | "justify"` field, mirroring the type in `packages/core/src/content/converters/types.ts`.

The Portable Text frontend renderer now emits a WordPress-style `has-text-align-{value}` class on the rendered `<p>` / `<h1..h6>` / `<blockquote>` whenever the block carries `textAlign`. A new `Block` component is added under `emdash/ui` for callers composing custom Portable Text components who want to keep the EmDash behaviour. The class allowlist is enforced via `Object.hasOwn`, so a hostile or hand-edited Portable Text block cannot inject arbitrary class names.

Consolidating the three duplicated converter pairs into a single shared module is a follow-up refactor and intentionally out of scope here.
