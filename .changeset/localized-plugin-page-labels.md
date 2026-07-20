---
"@emdash-cms/admin": minor
---

Plugin admin page labels in the sidebar and command palette are now run through the admin's Lingui instance. Plugins that load a message catalog (with the English label as the message id) get localized navigation, and labels matching one of the admin's own messages (such as "Settings") follow the admin locale automatically. Labels without a catalog entry render unchanged.
