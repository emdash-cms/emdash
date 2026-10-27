---
"emdash": patch
---

Fixes external auth providers, such as Cloudflare Access, writing the session store on every authenticated `/_emdash` request. EmDash now writes the session only when the signed-in user differs from the stored one, so sites on Cloudflare no longer spend one Workers KV write per request, which could exhaust the Workers Free plan's daily write limit and hit KV's one-write-per-second limit on a key for parallel requests.
