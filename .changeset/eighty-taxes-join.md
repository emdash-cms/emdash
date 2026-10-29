---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/plugin-types": patch
---

Updates the Zod dependency from 4.5.4 to 4.6.7 to address the reported high-severity `npm audit` warning for the older version. Upgrade EmDash and any separately installed plugin tooling to receive the updated dependency; refreshing a lockfile alone cannot replace the previous exact pin.
