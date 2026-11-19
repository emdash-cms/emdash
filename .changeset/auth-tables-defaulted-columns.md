---
"@emdash-cms/auth": patch
---

Updates `createKyselyAdapter()` to also accept a database whose columns with database defaults, such as `users.disabled` and `created_at`, are typed as `Generated`. EmDash's own database instance can now be passed without a type cast. The new `GeneratedAuthTables` type describes that shape, and schemas that match `AuthTables` keep working.
