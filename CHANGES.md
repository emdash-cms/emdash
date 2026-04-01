# CHANGES

## Pull Request Overview

This PR introduces a complete authentication upgrade and developer-experience improvements across EmDash:

- Full TOTP two-factor authentication (2FA) support (Google Authenticator/Authy/1Password compatible)
- Setup Wizard security step with three clear sign-in options
- QR-based authenticator onboarding flow
- Email-based setup completion path
- Bun runtime option in scaffolding
- PostgreSQL and MongoDB companion options in scaffolding

Author: @VMASPAD

---

## What Was Implemented

### 1. Two-Factor Authentication (TOTP) End-to-End

Implemented a full TOTP flow in core auth logic, API routes, and admin UI.

#### Core auth implementation

- Added a dedicated TOTP module with:
  - Secret generation
  - `otpauth://` URL generation
  - Time-window code verification
  - User-level 2FA state management (`pending`, `enabled`, `disabled`)
- Introduced structured helpers to enable/disable 2FA and to manage pending setup state.

#### API surface

Added new auth endpoints:

- `GET /_emdash/api/auth/2fa/status`
- `POST /_emdash/api/auth/2fa/setup`
- `POST /_emdash/api/auth/2fa/enable`
- `POST /_emdash/api/auth/2fa/disable`
- `GET /_emdash/api/auth/2fa/pending`
- `POST /_emdash/api/auth/2fa/verify`

These endpoints cover setup initialization, activation, deactivation, and second-factor verification at login.

#### Login integration

Updated passkey, magic-link, and OAuth login callbacks so that:

- If a user has 2FA enabled, login enters a pending second-factor state
- Session stores a temporary `pendingTwoFactor` challenge
- User must submit a valid TOTP code to complete authentication

---

### 2. Setup Wizard Security Methods (3 Options)

The setup flow now presents three explicit authentication choices:

1. Fingerprint/Passkey
2. Email code/link
3. Google Authenticator-style app (TOTP)

#### UX updates

- Clear card-style selection for all three methods
- Explicit copy differentiating email sign-in vs authenticator app codes
- QR rendering in setup for authenticator apps
- Method availability tied to email-provider readiness where required

---

### 3. QR-Based Authenticator Onboarding

Added QR generation to setup and security workflows:

- Generates a scannable QR from `otpauth://` payload
- Displays backup secret for manual entry
- Supports common authenticator apps

Dependencies added for QR generation in admin package.

---

### 4. Setup Completion via Email Sign-In

Added a dedicated setup endpoint:

- `POST /_emdash/api/setup/admin/email`

This endpoint:

- Creates the first admin user
- Marks setup as complete
- Sends initial magic-link sign-in email
- Handles email delivery failure gracefully while preserving completed setup state

Also exposed email availability in setup status response so UI can conditionally enable methods that rely on email.

---

### 5. Route Injection and Middleware Alignment

Updated route registration to include all new setup/auth endpoints so they are available at runtime.

Also updated auth/session middleware typing and public-route handling to support pending two-factor verification paths.

---

### 6. `create-emdash` Improvements (Runtime + Database)

Scaffolding flow now supports:

- Bun runtime selection
- Database selection for non-Cloudflare targets:
  - SQLite
  - PostgreSQL
  - MongoDB companion setup

#### PostgreSQL mode

- Rewrites generated config from SQLite to PostgreSQL
- Adds `DATABASE_URL` guidance in `.env.example`
- Ensures PostgreSQL dependency setup

#### MongoDB companion mode

- Adds `MONGODB_URL` to `.env.example`
- Adds `mongodb` dependency
- Generates helper file at `src/lib/mongodb.ts`
- Keeps EmDash core content storage SQL-based (companion usage is explicit)

---

## How It Works

### Authentication behavior

- Users may sign in with passkey, email, or OAuth depending on configuration.
- If 2FA is enabled for a user, primary auth is not enough.
- A short-lived pending challenge is stored in session.
- Login finalizes only after successful TOTP verification.

### Setup behavior

- Setup now clearly separates sign-in strategies.
- Authenticator option guides user through QR scan + first code verification.
- Email-based setup path finalizes installation and sends the first login link.

---

## Implementation Notes for Reviewers

- Route creation alone is not sufficient in this codebase; all new routes were also injected in integration routing.
- Setup and auth flows were updated in both backend and frontend to keep behavior consistent.
- Session shape was extended to support pending second-factor state.

---

## How To Use / Verify Locally

### 1. Build updated core package

```bash
pnpm --filter emdash build
```

### 2. Start a demo (example: simple)

```bash
pnpm --filter emdash-demo dev
```

### 3. Run setup wizard

- Go to `/_emdash/admin/setup`
- Complete site and admin steps
- In Security, choose one option:
  - Passkey
  - Email code/link
  - Google Auth app

### 4. Verify authenticator setup path

- Choose Google Auth app
- Scan QR with authenticator app
- Enter generated code
- Confirm successful redirect to admin

### 5. Verify login challenge

- Enable 2FA for the account
- Sign in with primary method
- Confirm second-factor prompt appears
- Enter TOTP code to complete login

---

## Validation Performed

- Quick lint checks
- Full lint diagnostics check
- Typecheck across workspace packages

All checks passed after final updates.

---

## Impact Summary

### Security

- Adds strong second-factor verification for protected admin access.

### Product UX

- Setup now communicates authentication choices clearly and reduces ambiguity.

### Developer Experience

- Faster project bootstrap flexibility with Bun and broader DB options.

### Backward Compatibility

- Existing passkey and magic-link flows remain supported.
- New functionality is additive and integrated into current auth architecture.
