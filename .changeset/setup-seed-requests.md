---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the setup wizard failing with "Failed to apply seed" on Cloudflare Workers when its sample content needs more database queries than one request allows. The wizard now adds sample content over as many requests as it needs and shows the progress. When a request fails, the content added so far is kept, and **Continue** adds the rest.
