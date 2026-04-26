---
"emdash": patch
---

MCP `taxonomy_list_terms` now uses an opaque base64 keyset cursor over `(label, id)` instead of the previous raw term-id cursor. The cursor is more robust to concurrent term deletion (it's a position rather than a row reference). MCP clients that persisted page cursors across an upgrade should drop them and restart pagination — old cursors will return `INVALID_CURSOR`.

Adds parent-chain validation to `taxonomy_create_term` (previously only `taxonomy_update_term` validated): rejects non-existent parents, cross-taxonomy parents, self-parent on update, cycles on update, and parent chains exceeding 100 ancestors. Existing taxonomies with chains over the depth limit continue to function but cannot accept new descendants until the chain is shortened.
