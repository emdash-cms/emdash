---
"emdash": patch
---

Fixes registry plugin installs, updates, and media previews failing on Cloudflare Workers with errors such as `The publisher DID document could not be fetched.` Registry HTTPS requests now use the Workers Fetch API instead of unsupported raw TCP sockets.
