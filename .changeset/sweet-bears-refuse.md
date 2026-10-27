---
"@emdash-cms/admin": patch
---

Fixes the admin editor offering URL editing for unregistered blocks without an existing `id` or `url`, including WordPress-imported buttons. These blocks now show an unavailable-editor notice instead of saving an unrelated URL onto the block. Imported embeds and files with existing URLs remain editable. This does not add a Buttons editor or remove previously saved stray URLs. Blocks that already contain a stray `id` still offer URL editing; removing that `id` from the stored Portable Text block disables those controls.
