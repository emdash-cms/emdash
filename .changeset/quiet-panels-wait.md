---
"@emdash-cms/admin": patch
---

Fixes sandboxed content editor panels giving no feedback during slow button actions or form submissions. Panels keep their controls visible and show a pending indicator while interactions run, and process additional interactions in order instead of cancelling the active request. Saved-version refreshes run in the background without replacing the panel with a skeleton.
