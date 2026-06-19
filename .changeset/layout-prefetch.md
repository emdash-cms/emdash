---
"emdash": patch
---

Speeds up public page loads on remote databases (D1, Durable Objects) by eagerly warming site-global layout data (menus, widget areas, taxonomy term lists, settings) at the start of the request, so the layout's per-component reads overlap into roughly one round trip instead of executing serially. Transparent to site code; no template changes needed.
