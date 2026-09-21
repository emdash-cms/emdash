---
"@emdash-cms/plugin-test": patch
"emdash": patch
---

Adds a disposable R2 bucket to `emdashPluginTest()` so sandbox plugin tests can exercise `ctx.media.upload()` and `ctx.media.delete()` through the same Worker Loader bridge used in production.

Fixes registry installation rejecting sandbox plugins whose manifests declare `content.publish`, `content.restore`, or `content.policy` access. These permissions now survive bundle-manifest validation and reach the normal installation consent checks.
