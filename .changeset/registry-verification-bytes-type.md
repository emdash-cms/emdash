---
"@emdash-cms/registry-verification": patch
---

Types `fetchVerifiedResource()` bytes as `Uint8Array<ArrayBuffer>`, so they can be passed to `new Response()` without a type assertion.
