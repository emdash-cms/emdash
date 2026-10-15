---
"emdash": patch
---

Fixes the admin dashboard for users without `content:read_drafts`, such as Subscribers. Recent activity and collection counts now include only published entries, matching what these users can open elsewhere in the admin, and scheduled-publication policy notices are no longer shown to them. Contributors and above see the dashboard as before.
