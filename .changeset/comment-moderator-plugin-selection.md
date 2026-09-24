---
"emdash": patch
---

Fixes new comments waiting for review with the reason "No moderator configured" on a site with one comment moderation plugin. When no `comment:moderate` choice is stored and exactly one plugin provides the hook, EmDash selects that plugin over the built-in moderator. EmDash no longer stores the built-in moderator as the choice when it is the only moderator, so a moderation plugin added later takes over.

A choice stored by an earlier release is kept, which on most existing sites is the built-in moderator. The admin route `PUT /_emdash/api/admin/hooks/exclusive/comment:moderate` currently changes a stored choice.
