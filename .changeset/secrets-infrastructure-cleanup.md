---
"emdash": minor
---

Adds a centralized secrets module and `emdash secrets` CLI command group.
The preview HMAC secret and commenter-IP hash salt are now generated and
persisted in the options table on first need, with `EMDASH_PREVIEW_SECRET`
and `EMDASH_IP_SALT` as optional env overrides. This replaces the previous
empty-string preview fallback (which silently disabled token verification)
and the hardcoded `"emdash-ip-salt"` constant (which was correlatable
across installs).

Adds:

- `emdash secrets generate [--write <file> [--force]]` — emits a fresh
  `EMDASH_ENCRYPTION_KEY` (versioned `emdash_enc_v1_<43 chars>` format),
  optionally writes it to `.dev.vars` or `.env` idempotently.
- `emdash secrets fingerprint <key>` — prints the kid (8-char fingerprint)
  for a key without exposing its value.

Lays groundwork for plugin-secret encryption-at-rest in a follow-up.

Deprecates:

- `emdash auth secret` — kept as a working alias that prints a stderr
  deprecation note. Will be removed in a future minor. `EMDASH_AUTH_SECRET`
  itself is now legacy: it's only consulted as a fallback IP-salt source
  for upgrade compatibility (so existing installs keep stable
  commenter-IP hashes). New installs don't need to set it.

API changes:

- `fingerprintKey()` (exported from `emdash`'s config module) now
  validates its input and throws `EmDashSecretsError` for malformed or
  non-canonical keys, where it previously silently hashed any string.
  Callers that want the previous "fingerprint anything" behavior should
  hash the input themselves with `crypto.subtle.digest`.

User-visible side effects on upgrade:

- Installs that hadn't set `EMDASH_PREVIEW_SECRET` get a fresh random
  preview secret on first start, which invalidates any outstanding
  preview URLs (typically short-lived).
- Installs that hadn't set `EMDASH_AUTH_SECRET` get a fresh random IP
  salt, resetting active comment rate-limit windows once.
- Installs that did set `EMDASH_AUTH_SECRET` keep the same IP salt via a
  legacy fallback, so existing rate-limit data carries over.
- If you sign preview URLs from a separate process without access to the
  EmDash database (e.g. a remote preview Worker), you must continue to
  set `EMDASH_PREVIEW_SECRET` in **both** processes. Processes that share
  the database converge on the same auto-generated value automatically;
  the env override is only needed when the verifying process can't read
  the options table.
