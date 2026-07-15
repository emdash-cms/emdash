---
"emdash": minor
---

Moves the `Comments` and `CommentForm` components from `emdash/ui` to a dedicated `emdash/ui/comments` entry point so their CSS is no longer loaded on pages that don't render comments. Previously, importing anything from `emdash/ui` (such as `PortableText`) pulled the comment styles into a shared, render-blocking stylesheet on every page.

Migration: update comment imports from `import { Comments, CommentForm } from "emdash/ui"` to `import { Comments, CommentForm } from "emdash/ui/comments"`.
