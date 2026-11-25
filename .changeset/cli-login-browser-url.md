---
"emdash": patch
"@emdash-cms/plugin-cli": patch
---

`emdash login` and `emdash-plugin login` now open the sign-in page in your browser only when its address is an `http:` or `https:` URL. Any other address is still printed, so you can open it yourself. On Windows, `emdash-plugin login` now passes the full authorization URL to the browser, including the part after the first `&`.
