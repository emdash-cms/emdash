---
"emdash": patch
---

Exports the email hook types (`EmailMessage`, `EmailDeliverEvent`, `EmailBeforeSendEvent`, `EmailAfterSendEvent` and their handler types) from `emdash`, so a plugin that provides `email:deliver` or hooks `email:beforeSend` / `email:afterSend` can type its handlers without copying the definitions.
