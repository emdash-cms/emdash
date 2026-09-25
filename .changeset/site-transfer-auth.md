---
"@emdash-cms/auth": minor
---

Adds the `transfer:export`, `transfer:analyze`, and `transfer:execute` token scopes and the admin-only `transfer:export` and `transfer:import` permissions for site export and import. `admin` grants all three; each transfer scope grants only itself, so a token can be limited to one transfer action. The `TRANSFER_SCOPES` constant and `isTransferScope()` helper identify these scopes.
