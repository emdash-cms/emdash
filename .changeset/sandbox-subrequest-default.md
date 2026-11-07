---
"@emdash-cms/cloudflare": patch
---

Raise the default sandboxed-plugin subrequest limit from 10 to 32.

Every host call a sandboxed plugin makes — storage read/write, KV, email send, content read — is one subrequest through the bridge binding. A single route handler that does a few reads and a write already exceeds 10 and fails with "Too many subrequests by single Worker invocation", even on a Workers Paid plan whose real ceiling is far higher. The default now matches Cloudflare's own per-request Worker invocation ceiling (32), which still bounds a runaway plugin. Deployments that need a different limit can still pass `limits` to the sandbox runner.
