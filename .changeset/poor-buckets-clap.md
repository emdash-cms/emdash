---
"emdash": minor
---

**Behavior change** — MCP `taxonomy_list_terms` now uses an opaque base64 keyset cursor over `(label, id)` instead of the previous raw term-id cursor. The new cursor is robust to concurrent term deletion: it encodes a position in sort space rather than a reference to a specific row. **MCP clients that persisted page cursors across this upgrade should drop them and restart pagination** — pre-upgrade cursors will return `INVALID_CURSOR`.

Adds parent-chain validation to `taxonomy_create_term` (previously only `taxonomy_update_term` validated): rejects non-existent parents, cross-taxonomy parents, self-parent on update, cycles on update, and parent chains exceeding 100 ancestors. Existing taxonomies with chains over the depth limit continue to function but cannot accept new descendants until the chain is shortened.
