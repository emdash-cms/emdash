---
"emdash": minor
---

Add comment reactions

Visitors can now react to approved comments (positive-only "like" by default,
extensible to other reaction types). Reactions are deduped per voter via IP hash.

The `<Comments>` component gains two opt-in props:

- `reactions` — render a like button per comment and attach live counts.
- `sort="best"` — order top-level comments by a Reddit-style Wilson score
  lower bound (`sort="oldest"`, the previous behavior, remains the default).

Posting is progressively enhanced (a tiny inline script, no framework island)
and emitted only when `reactions` is enabled, so pages that don't use reactions
ship zero additional JavaScript. Fully additive and backward-compatible: a new
table, a new route, and new optional props with behavior-preserving defaults.
