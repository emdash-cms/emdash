---
"emdash": minor
---

Add comment reactions (Tier 1 of the best-in-class comments RFC).

Visitors can now react to approved comments (positive-only "like" by default,
extensible to other reaction types). Reactions are stored first-party in a new
`_emdash_comment_reactions` table, deduped per voter via a salted IP hash (the
same privacy primitive as comment `ip_hash`), and exposed through a public,
honeypot- and rate-limited endpoint at
`POST/GET /_emdash/api/comments/:collection/:contentId/reactions`.

The `<Comments>` component gains two opt-in props:

- `reactions` — render a like button per comment and attach live counts.
- `sort="best"` — order top-level comments by a Reddit-style Wilson score
  lower bound (`sort="oldest"`, the previous behavior, remains the default).

Posting is progressively enhanced (a tiny inline script, no framework island)
and emitted only when `reactions` is enabled, so pages that don't use reactions
ship zero additional JavaScript. Fully additive and backward-compatible: a new
table, a new route, and new optional props with behavior-preserving defaults.
