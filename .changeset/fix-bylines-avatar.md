---
"@emdash-cms/admin": patch
---

fix(admin/bylines): add avatar upload control to byline editor

The `avatarMediaId` field was already supported by the API but had no UI control in the admin bylines page. Added a `MediaPickerModal` image picker between Bio and Linked user, with thumbnail preview, change/remove actions, and proper inclusion in create/update payloads. (#1250)
