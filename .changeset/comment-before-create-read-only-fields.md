---
"emdash": patch
---

Updates `comment:beforeCreate` so that only the `authorName`, `authorEmail`, `body`, and `metadata` a handler returns are used. Changes a handler makes to `collection`, `contentId`, `parentId`, `authorUserId`, `ipHash`, or `userAgent` are now ignored, and the comment keeps the values from the submission. A plugin that rewrote those fields from this hook no longer can.
