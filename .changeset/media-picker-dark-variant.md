---
"@emdash-cms/blocks": minor
"@emdash-cms/admin": minor
---

Adds an opt-in `dark_variant` option to the Block Kit `media_picker` element (`mediaPicker("logo", "Logo", { darkVariant: true })`), so editors can add a dark mode image to a picked image in a plugin's Portable Text block. The variant's URL is stored beside the primary value under `<action_id>_dark`, so existing values stay plain URL strings. Render both with `<Image image={node.logo} darkVariant={node.logo_dark} />`. Validation rejects a `dark_variant` picker whose `_dark` key another element already uses.
