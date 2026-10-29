---
"@emdash-cms/admin": patch
---

Fixes sandboxed content editor panels giving no feedback during slow button actions or form submissions. Panels keep their controls visible and show a pending indicator while interactions run. Additional interactions run in order instead of cancelling the active request, and consecutive duplicates of a running or queued interaction are ignored. Editing the entry allows a new draft-aware action even while the same button’s earlier request is pending. Saved-version refreshes run in the background without replacing the panel with a skeleton, and superseded loads are cancelled so the latest refresh can start promptly.
