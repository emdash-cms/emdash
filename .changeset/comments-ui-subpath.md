---
"emdash": minor
---

Adds `emdash/ui/comments` for `Comments` and `CommentForm` so their CSS only loads on pages that import them. Importing from `emdash/ui` still works but is deprecated and will be removed in 1.0 — prefer `import { Comments, CommentForm } from "emdash/ui/comments"`.
