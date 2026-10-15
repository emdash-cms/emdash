---
"emdash": patch
"@emdash-cms/auth": patch
---

Fixes Contributors being unable to save changes to their own drafts. A Contributor could create an entry, but the next save, the entry lock, and setting categories or tags returned 403. Contributors can now edit their own entries while they are drafts, in the admin, the REST API, and the MCP `content_update` tool. They still cannot edit entries once they are published or scheduled, or publish them.

The new `content:edit_own_drafts` permission grants this and is held by Contributor and every higher role. No other role's permissions change.
