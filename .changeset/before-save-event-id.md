---
"emdash": minor
---

Adds `id` to the `content:beforeSave` hook event when an existing item is updated, for both trusted and sandboxed plugins. `event.content` holds only the submitted field values, so a hook that needs the stored item, for example to audit or validate a change against it, can call `ctx.content.get(event.collection, event.id)`. The field is absent on creates.
