---
"emdash": patch
---

Fixes byline translations dropping the source byline's linked user, which left the user's entries in the translation's locale without an author credit. Translations created with the admin's Translate action now keep the source's user, so those entries show the translated byline.

When `translationOf` is set and the call omits `userId`, the `byline_create` MCP tool now links the source's user instead of creating an unlinked translation. Pass `userId: null` to keep the previous behavior.

A user can have only one byline per locale. Creating a byline with a `userId` that already has a different byline in the target locale fails with `CONFLICT` naming that byline, instead of a server error. Translating a byline whose user already has a different byline in the target locale also fails with `CONFLICT`, where it previously created an unlinked translation.

#### What should I do?

Translations created before this release stay unlinked, and the admin's byline list marks them as unlinked. To restore author credits in a locale, open the translation in the admin and link the user.

If Translate reports that the user is already linked to another byline in that locale, unlink that byline in the admin first, or create the translation with `byline_create` and `userId: null`.
