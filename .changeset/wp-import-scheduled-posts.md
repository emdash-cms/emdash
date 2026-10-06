---
"emdash": patch
---

Fixes scheduled WordPress posts being imported as plain drafts. The WordPress export file (WXR) import and the WordPress plugin import in the admin now schedule them for their original publish date. Posts whose scheduled date has already passed are still imported as drafts. Posts imported before this fix are skipped on a re-import, so schedule them from the editor or delete and import them again.

The WordPress plugin import also reads post dates as UTC now. On Node servers running in a time zone other than UTC, imported created and modified dates were shifted by the server's offset.
