---
"@emdash-cms/admin": patch
---

Fixes sandboxed content editor panels showing no loading feedback after button clicks or form submissions. Panels now show a loading skeleton during every request, including refreshes after an entry is saved. Previous controls are hidden while loading so another panel button click cannot cancel the pending interaction, while local form, tab, and accordion state is preserved across loading.
