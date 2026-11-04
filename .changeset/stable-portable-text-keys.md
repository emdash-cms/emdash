---
"@emdash-cms/admin": patch
---

Fixes rich text block keys changing on every save. Blocks added in the editor now keep the same `_key` from save to save, so saving the same content twice gives identical Portable Text. Saving also stops changing a few stored shapes:

- List items that start at a nested level keep their level.
- Line breaks inside table cells keep their spans.
- A span marked both subscript and superscript keeps subscript.
- Two links that share a mark definition keep their own destinations.
- An empty last line, such as the one the editor adds after a final image, isn't saved.

If a plugin block is deleted while its edit dialog is open, the dialog now stays open, keeps what you typed, and says the changes can't be saved. Before, it closed and dropped the input.
