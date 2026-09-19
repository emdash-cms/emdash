---
"@emdash-cms/admin": patch
---

Fixes the content editor saving the writer's copy over a newer version of an entry while the notice that the entry changed somewhere else is shown. Publishing, scheduling, removing a schedule, unpublishing, and changing the publication date each saved that copy first, and publishing then made it live. During the conflict, the publishing controls are disabled, a publication date change is refused in its dialog, and a save that was already waiting when the conflict arrived is not sent. **Save anyway** still saves the writer's copy.
