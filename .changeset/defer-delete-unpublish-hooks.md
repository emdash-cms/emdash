---
"emdash": patch
---

Fixes plugin `content:afterDelete` and `content:afterUnpublish` hooks being dropped on Cloudflare Workers. Cleanup work in these hooks — removing uploaded files, clearing search indexes — now runs to completion after content is deleted or unpublished, instead of being canceled the moment the response is sent. Previously this could also leave plugin storage in a wedged state that hung later admin requests.
