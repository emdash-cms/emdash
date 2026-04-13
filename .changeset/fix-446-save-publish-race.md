---
"emdash": patch
---

Fixes save/publish race condition in visual editor toolbar. When a user blurred a field and immediately clicked Publish, the in-flight save PUT could arrive at the server after the publish POST, causing the stale revision to be promoted silently. Introduces `pendingSavePromise` so `publish()` chains onto the pending save rather than firing immediately.
