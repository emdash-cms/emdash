---
"emdash": patch
---

Locks `emdash:site_url` after the first setup call so a spoofed Host header on a later step of the wizard can't overwrite it. Config (`siteUrl`) and env (`EMDASH_SITE_URL`) paths already took precedence; this is a defence-in-depth guard for deployments that rely on the request-origin fallback.
