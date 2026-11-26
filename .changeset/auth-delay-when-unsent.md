---
"@emdash-cms/auth": minor
---

Adds a `delayWhenUnsent` option to the config of `sendMagicLink()` and `requestSignup()`. It defaults to `true`, which keeps the existing 100-250 ms wait before resolving when nothing is sent. Set it to `false` when you run the call after your response has been sent, for example with `after()` from `emdash`, so the deferred task doesn't wait for nothing.
