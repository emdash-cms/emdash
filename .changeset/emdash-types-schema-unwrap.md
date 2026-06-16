---
"emdash": patch
---

Fix `npx emdash types` crash caused by the schema endpoint envelope (#1188)

The `/schema` route returned an enveloped JSON body while `client.request()` already unwraps the `.data` field, so `emdash types` received `undefined` and crashed. The route now returns the un-enveloped shape the client expects.
