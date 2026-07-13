---
"@emdash-cms/admin": minor
---

Plugin admin page labels in the sidebar and command palette are now run through the admin's Lingui instance, so plugins that load a message catalog (with the English label as the message id) get localized navigation. Labels without a catalog entry render unchanged.
