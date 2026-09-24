---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds the `sandboxLimits` integration option so site operators can configure CPU, subrequest, memory, and wall-time limits for sandboxed plugin invocations.

Cloudflare sandboxed plugins now receive a default budget of 30 subrequests per invocation instead of 10. This leaves room for bridge-backed storage, settings, content, network, and logging operations up to Cloudflare's 32-Worker request-chain limit. Sites can retain the previous budget explicitly:

```js
import { sandbox } from "@emdash-cms/cloudflare";

emdash({
	sandboxRunner: sandbox(),
	sandboxLimits: { subrequests: 10 },
});
```

EmDash and Cloudflare Worker Loader enforce the subrequest limit, including in `@emdash-cms/plugin-test`; Worker Loader enforces CPU limits after deployment. Both the Cloudflare and Node.js runners enforce wall time. Standalone workerd cannot enforce CPU, memory, or subrequest limits.
