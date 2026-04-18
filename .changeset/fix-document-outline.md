---
"@emdash-cms/admin": patch
---

Fix document outline not showing headings on initial load. The outline now defers initial extraction to next tick (so TipTap finishes hydrating) and also listens for transaction events to catch programmatic content changes.
