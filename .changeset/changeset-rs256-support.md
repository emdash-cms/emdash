---
"@emdash-cms/auth": patch
"emdash": patch
---

Enhances Passkey authentication with polymorphic algorithm support. Adds support for RS256 (RSA) alongside the existing ES256 (ECDSA) implementation, ensuring full compatibility with Windows Hello, hardware security keys, and FIDO2 standards. Includes a database migration to track and persist credential algorithms for future-proof authentication.

Note for standalone `@emdash-cms/auth` consumers: If your `credentials` table already exists, you must manually run `ALTER TABLE credentials ADD COLUMN algorithm INTEGER NOT NULL DEFAULT -7` to support this update.
