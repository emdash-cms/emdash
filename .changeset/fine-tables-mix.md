---
"emdash": patch
"@emdash-cms/auth": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/auth-atproto": patch
---

Upgrades `kysely` to `^0.29.0` (was `^0.27.0`) to resolve three high-severity advisories fixed in `>=0.28.17`:

- GHSA-wmrf-hv6w-mr66 – SQL injection via unsanitized JSON path keys
- GHSA-pv5w-4p9q-p3v2 – JSON-path traversal injection via `JSONPathBuilder.key()` / `.at()`
- GHSA-8cpq-38p9-67gx – MySQL SQL injection via `sql.lit(string)`

Also updates import paths for `Migrator` and `Migration` types to `kysely/migration` to comply with kysely 0.29 export changes.
