---
"emdash": patch
---

Fixes menu items added via the admin content picker from a custom collection linking to the collection archive (`/projects/`) instead of the selected entry (`/projects/widget-co`). Entry references now resolve like page and post items, including `urlPattern` support and per-locale resolution; items whose referenced entry no longer exists are hidden instead of pointing at the archive. Archive links (collection items without an entry reference) are unchanged.
