---
"emdash": patch
---

Fixes an entry with a pending draft becoming unsaveable after one of its fields is deleted. The draft revision stores the whole `data`, so the deleted field's value stayed in it and every read handed it back; writing that data back was then refused with `unknown field on collection`, an explicit `null` was refused too, and omitting the key was accepted but left the merge carrying it, so no request body got the entry out of the state. An update now drops a key the collection has no field for when the entry already stores it, and a saved entry is written without those keys, so it sheds them. A key the entry does not already store is still reported as an unknown field. This applies to every content write, including those made from a plugin or a sandboxed plugin bridge.
