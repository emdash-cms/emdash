---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
---

Adds two structured Block Kit elements so plugin blocks can carry rich text and nested block content that stays fully editable in the admin editor, plus a Duplicate action on plugin block cards.

#### `portable_text`

A rich-text field whose value is a Portable Text block array. The plugin block dialog renders it as a nested instance of the standard Portable Text editor, so authors get the familiar writing surface and the stored value keeps its complete structure — blocks, spans, marks, markDefs, and keys. The value is never flattened to a string. Like `repeater`, the runtime `renderElement` returns `null`; the parent block's own component renders the persisted value.

```ts
{ type: "portable_text", action_id: "content", label: "Content" }
```

#### `block_list`

An ordered list of registered plugin blocks. In the dialog, authors add an item by choosing from the same registered block catalog the document editor offers and filling that block's own Block Kit form, then edit, duplicate, delete, and drag-to-reorder items. When a form contains several block lists (for example one per column, including lists nested in `repeater` rows), each item also offers "Move to…" the sibling list. Each stored item is an ordinary registered block object — `{ _type, _key, ...fields }` — never serialized HTML or a private document format. `allowed_types` restricts which registered blocks may be added; `min_items`/`max_items` bound the list.

```ts
{ type: "block_list", action_id: "blocks", label: "Blocks", allowed_types: ["acme.heading"] }
```

Both element types are also accepted as `repeater` sub-fields, so a repeater row can carry rich text or its own ordered block list.

#### `hidden` on plugin block definitions

A plugin block definition may declare `hidden: true`: the block stays registered — existing blocks of the type render and edit exactly as before — but document-level insert surfaces (the slash menu, and a `block_list` picker without an `allowed_types` list) no longer offer it. A `block_list` whose `allowed_types` names the type still offers it, so a plugin can ship child-only blocks that authors reach exclusively inside the parent blocks that declare them.

#### Duplicate on plugin block cards

Plugin block cards in the document editor gain a Duplicate action beside Edit and Delete that inserts a copy of the block, with identical data, immediately after the original.
