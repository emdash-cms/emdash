---
"emdash": patch
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin login` on Windows opening the authorization URL cut off at the first `&`, so you no longer have to copy the printed URL into the browser. On Windows, `emdash login` and `emdash-plugin login` no longer pass the login URL through `cmd.exe`, so a URL returned by the server can no longer run commands on your machine or insert environment variables into the address. Both commands now open only `http:` and `https:` URLs automatically; other URLs are still printed.
