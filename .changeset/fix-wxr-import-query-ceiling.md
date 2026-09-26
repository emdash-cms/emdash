---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes WordPress WXR imports failing partway through large exports. The admin now imports taxonomy terms, content, and reusable blocks in bounded requests while preserving translation links and the complete import summary.

Direct API clients can continue using a single request for small exports. Larger exports return `WXR_IMPORT_TOO_LARGE` and must use the chunked `taxonomy`, `content`, and `finalize` phases.
