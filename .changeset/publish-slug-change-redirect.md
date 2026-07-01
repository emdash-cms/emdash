---
"emdash": patch
---

Fixes slug-change 301 auto-redirects not being created for published entries in revision-supporting collections. Editing a published entry's slug in the admin stages the change as `_slug` inside a draft revision; on "Publish", `ContentRepository.publish()` synced the new slug straight into the content table — bypassing `handleContentUpdate`, the only place auto-redirects were created. Since collections support drafts + revisions by default, the advertised "Auto: slug change" redirect effectively never fired for the standard editing flow, silently breaking old URLs. Publishing now leaves a 301 from the old URL behind whenever an already-published entry's slug changes. First publishes are excluded (a draft's URL was never public), and direct API slug updates behave as before.
