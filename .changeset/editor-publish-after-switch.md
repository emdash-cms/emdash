---
"@emdash-cms/admin": patch
---

Fixes **Publish** in the content editor when you open another entry before the publish finishes. The entry you clicked Publish on stayed a draft, and the publish was sent for the entry you had moved to, where it failed. It now publishes the entry you clicked it on.
