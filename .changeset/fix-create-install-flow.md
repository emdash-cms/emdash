---
"create-emdash": patch
---

Fixes `create-emdash --install` failing for Cloudflare templates whose Wrangler version requires `@cloudflare/workers-types` 5. Package-manager output is streamed; any remaining install failure keeps the generated files, prints a retry command, and exits nonzero.
