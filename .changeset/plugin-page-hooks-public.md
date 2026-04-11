---
"emdash": patch
---

Fix plugin `page:metadata` and `page:fragments` hooks not firing for anonymous public page visitors. The middleware's early-return fast-path for unauthenticated requests now initializes the runtime (skipping only the manifest query), so plugin contributions render via `<EmDashHead>`, `<EmDashBodyStart>`, and `<EmDashBodyEnd>` for all visitors. Also adds `collectPageMetadata` and `collectPageFragments` to the `EmDashHandlers` interface.
