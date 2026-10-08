---
"@emdash-cms/registry-client": patch
"@emdash-cms/plugin-cli": patch
---

Adds an optional `reasonMessage` to delegated release intents and shows it in `emdash-plugin release` output. Failed releases include the intent ID and guidance for resolving the failure, including when to start a fresh workflow dispatch. Clients remain compatible with release services that return only a reason code.
