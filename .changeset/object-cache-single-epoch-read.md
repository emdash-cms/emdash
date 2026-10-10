---
"emdash": patch
---

Fixes the object cache reading one epoch key per namespace on every render once `revalidate` has passed. On Workers KV with `kvCache()`, a page that reads several collections, menus, bylines, and taxonomies now usually reads one change-marker key to revalidate all of them, instead of one KV read per namespace. Isolates still pick up a change within KV propagation plus `revalidate`. After deploying, the saving starts with the first content, menu, or settings change, because older releases do not write the marker. With `revalidate: 0`, every query still reads its epochs directly.
