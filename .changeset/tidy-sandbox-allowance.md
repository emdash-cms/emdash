---
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
---

Fixes AT Protocol plugin settings and publication sync failing under the default Cloudflare sandbox budget by raising the subrequest allowance from 10 to 100 per invocation. Settings reads and other bridge calls share this budget with HTTP requests; the previous allowance could stop a sync after creating a publication on the PDS but before saving its URI, causing retries to create duplicates.

CPU and wall-time limits are unchanged. Existing explicit `limits.subrequests` overrides still apply. The Node.js workerd runner uses the same default value but does not enforce subrequest limits. No configuration changes are required, and this update does not remove duplicate records already created on a PDS.

To retain the previous ceiling, supply a custom runner module through `emdash({ sandboxRunner: ... })`. Its exported `createSandboxRunner` factory must pass `limits: { subrequests: 10 }` in the `SandboxOptions` supplied to `CloudflareSandboxRunner` or `createSandboxRunner` from `@emdash-cms/cloudflare/sandbox`. These are runtime-only APIs; neither `sandbox()` nor `emdash()` accepts a direct `limits` option. See the [custom runner example](https://docs.emdashcms.com/deployment/plugin-sandbox/#custom-resource-limits). Retaining 10 subrequests can reproduce the AT Protocol failures described above.
