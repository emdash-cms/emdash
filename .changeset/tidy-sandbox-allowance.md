---
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Raises the default sandbox subrequest allowance from 10 to 30 per invocation, allowing plugins to make more settings, storage, and HTTP bridge calls before reaching the budget. On Cloudflare, 30 bridge calls is the maximum permitted by the platform's Worker-invocation cap. The Node.js workerd runner uses the same default value but does not enforce subrequest limits.

CPU and wall-time limits are unchanged, and existing explicit `limits.subrequests` overrides still apply. No configuration changes are required.

To retain the previous ceiling, supply a custom runner module through `emdash({ sandboxRunner: ... })`. Its exported `createSandboxRunner` factory must pass `limits: { subrequests: 10 }` in the `SandboxOptions` supplied to `CloudflareSandboxRunner` or `createSandboxRunner` from `@emdash-cms/cloudflare/sandbox`. These are runtime-only APIs; neither `sandbox()` nor `emdash()` accepts a direct `limits` option. See the [custom runner example](https://docs.emdashcms.com/deployment/plugin-sandbox/#custom-resource-limits).
