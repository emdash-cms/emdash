---
"@emdash-cms/admin": patch
---

Fixes the content editor saving the writer's copy over a newer version of an entry while the notice that the entry changed somewhere else is shown. Publishing, scheduling, removing a schedule, unpublishing, and changing the publication date each saved that copy first, and publishing then made it live.

During the conflict, the publishing controls are disabled, a publication date change is refused in its dialog, and a save that was already waiting when the conflict arrived is not sent. Changing the author or the SEO fields still writes, and still replaces what it sends on the newer version, but it no longer clears the notice, and what the writer typed stays in the form instead of being replaced by the newer version. **Save anyway** still saves the writer's copy.
