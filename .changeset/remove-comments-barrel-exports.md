---
"emdash": patch
---

Removes the deprecated `Comments` and `CommentForm` exports from `emdash/ui`. Sites that still import either component from `emdash/ui` fail to build after upgrading.

Import them from `emdash/ui/comments` instead:

```diff
- import { Comments, CommentForm } from "emdash/ui";
+ import { Comments, CommentForm } from "emdash/ui/comments";
```

The components themselves are unchanged. Importing them from `emdash/ui/comments` also keeps comment styles off pages that don't render comments.
