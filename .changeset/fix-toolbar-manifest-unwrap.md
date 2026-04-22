---
"emdash": patch
---

Fixes visual editing: clicking an editable field now opens the inline editor instead of always opening the admin in a new tab. The toolbar's manifest fetch was reading `manifest.collections` directly but the `/_emdash/api/manifest` endpoint wraps its payload in `{ data: … }`, so every field-kind lookup returned `null` and every click fell through to the admin-new-tab fallback.
