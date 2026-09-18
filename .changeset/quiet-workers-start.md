---
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Adds `emdash/plugins/host` as a narrow runtime entry for platform sandbox adapters. The Cloudflare Worker loads scheduled maintenance and sandbox bridge dependencies when those capabilities first run, reducing startup CPU while preserving existing Worker exports and behavior.
