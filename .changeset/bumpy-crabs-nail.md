---
"emdash": minor
"@emdash-cms/cloudflare": patch
"@emdash-cms/workerd": minor
---

Adds workerd-based plugin sandboxing for Node.js deployments.

- **emdash**: Adds `isHealthy()` to `SandboxRunner` interface, `SandboxUnavailableError` class, `sandbox: false` config option, and exports `createHttpAccess`/`createUnrestrictedHttpAccess` for platform adapters.
- **@emdash-cms/cloudflare**: Implements `isHealthy()` on `CloudflareSandboxRunner`.
- **@emdash-cms/workerd**: New package. `WorkerdSandboxRunner` for production (workerd child process + capnp config + authenticated HTTP backing service) and `MiniflareDevRunner` for development.
