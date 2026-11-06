---
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes AT Protocol plugin settings and publication sync failing under the default Cloudflare sandbox budget by raising the subrequest allowance from 10 to 100 per invocation. Settings reads and other bridge calls share this budget with HTTP requests; the previous allowance could stop a sync after creating a publication on the PDS but before saving its URI, causing retries to create duplicates.

CPU and wall-time limits are unchanged. Existing explicit `limits.subrequests` overrides still apply. The Node.js workerd runner uses the same default value but does not enforce subrequest limits. No configuration changes are required, and this update does not remove duplicate records already created on a PDS.
