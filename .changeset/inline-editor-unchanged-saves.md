---
"emdash": patch
---

Fixes visual editing saving a new draft when nothing changed. With edit mode on, the inline Portable Text editor saved the body every time focus left it and every time the page was left, even if no one had typed, because each save check compared freshly generated block keys against the stored ones. Entries picked up drafts that differed only in `_key` and showed "Pending changes" in the admin. The editor now compares its document with the one last saved, so an unedited body is never saved and a real edit is saved once.
