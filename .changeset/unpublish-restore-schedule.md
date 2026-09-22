---
"emdash": patch
---

Fixes entries going live again after they were unpublished or restored from Trash.

Unpublishing an entry cancels its pending schedule, so scheduled publishing no longer republishes it when the old time arrives. Restoring an entry from Trash returns it as a draft with no schedule, whatever its status was when it was trashed: a published entry is no longer public again the moment it is restored, and a schedule is dropped whether or not it has come due. This applies to **Restore** in the admin, `POST /_emdash/api/content/{collection}/{id}/restore`, the `content_restore` MCP tool, `emdash content restore`, and `EmDashClient.restore()`. Scripts and agents that restore an entry and expect it to be live must publish or schedule it afterwards. `content:afterRestore` hooks receive the entry with `status: "draft"`.
