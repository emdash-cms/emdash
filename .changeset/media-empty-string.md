---
"emdash": patch
---

Fixes saving an entry turning an empty image or file field (`""`) into `{ "provider": "external", "id": "", "src": "" }`. A blank image or file value, including one inside a repeater, is now saved as `null`, the canonical empty value. Entries with no image stop changing on every save after that.
