---
"@emdash-cms/admin": patch
---

Updates the post editor to create and edit bylines with the same form as the Bylines page. Choosing **Create** in a post's byline search opens the full form with the name filled in, so editors can add a website, bio, avatar, linked user, and custom fields before the byline is added to the post. **Edit name and slug** is now **Edit byline** and edits every field. The Bylines panel also appears on new posts before their first save.

Bylines created from the post editor are no longer marked as guests by default. Previously, every byline created there was a guest; it now starts as a regular byline, as on the Bylines page. To credit a guest writer, turn on **Guest byline** in the form. Sites whose templates read `byline.isGuest` show new bylines from the post editor as regular bylines unless that switch is on. Existing bylines don't change.

Custom admins that render `ContentEditor` now receive every form field, including `isGuest`, in `onQuickCreateByline` and `onQuickEditByline`, not just `slug` and `displayName`. Existing callbacks keep working; a callback that marked new bylines as guests before spreading the input now gets the form's `isGuest` value instead.
