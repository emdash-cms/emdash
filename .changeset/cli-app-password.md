---
"@emdash-cms/plugin-cli": minor
---

Adds non-interactive `emdash-plugin publish` authentication for CI via atproto app passwords.

Set `EMDASH_PUBLISHER_APP_PASSWORD` in the environment and pass `--publisher <handle-or-did>` (or set `EMDASH_PUBLISHER_DID` / `EMDASH_PUBLISHER_HANDLE`) to publish without the browser-based OAuth dance. The interactive OAuth path is unchanged when no app password is set.

Guardrails refuse a full-account credential (only `com.atproto.appPass` and `com.atproto.appPassPrivileged` scopes are accepted), reject malformed `xxxx-xxxx-xxxx-xxxx` strings before any network call, and cross-check the logged-in DID against the resolved publisher identifier. Failures surface stable error codes through `--json` mode for CI consumers: `APP_PASSWORD_FORMAT`, `MISSING_APP_PASSWORD`, `MISSING_PUBLISHER` (exit 2, config errors); `INVALID_PUBLISHER`, `APP_PASSWORD_LOGIN_FAILED`, `FULL_ACCOUNT_CREDENTIAL`, `PUBLISHER_DID_MISMATCH` (exit 1, runtime errors).
