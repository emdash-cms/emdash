---
"@emdash-cms/admin": patch
---

Fixes the content list showing a "Pending changes" badge on entries that have never been published. A draft or scheduled entry has a draft revision and no live revision, which the list read as a difference between the two. The badge now appears only where there is a published version for the changes to be pending against, matching the state the editor shows for the same entry.
