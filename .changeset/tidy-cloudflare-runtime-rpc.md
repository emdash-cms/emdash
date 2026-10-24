---
"@emdash-cms/cloudflare": patch
---

Fixes sandboxed plugin taxonomy writes, content creation and publishing, and comment moderation on Cloudflare when requests run across multiple Worker isolates. Content creation now consistently uses runtime validation and hooks and preserves `translationOf` links instead of falling back to a plain database insert.
