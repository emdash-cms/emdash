/**
 * Types for the TOTP (RFC 6238) authentication module.
 *
 * TOTP is offered as an alternative to passkeys for both first-run admin
 * setup and ongoing login. The secret is generated server-side, encrypted
 * at rest with the HKDF path from tokens.ts (NOT the PBKDF2 path — TOTP
 * secrets are already high-entropy random bytes), and verified against
 * incoming codes via @oslojs/otp's HOTP primitive at the current epoch
 * counter.
 *
 * Discussion: https://github.com/emdash-cms/emdash/discussions/432
 */

/**
 * A persisted TOTP credential bound to a single user.
 *
 * One row per user. The encryptedSecret is the HKDF-encrypted base32
 * secret bytes — never store the plaintext or the HMAC key directly.
 *
 * lastUsedStep is the RFC 6238 epoch counter (`floor(now / period)`)
 * of the most recent successful verification. Replay protection rejects
 * any incoming code whose candidate step is `<= lastUsedStep`, so a code
 * that worked for one login cannot work twice within the same 30s window.
 *
 * failedAttempts counts consecutive verification failures. Successful
 * login resets it to 0. When it reaches LOCKOUT_THRESHOLD, the row is
 * locked until lockedUntil — only a recovery code can unlock it.
 */
export interface TOTPSecret {
	userId: string;
	encryptedSecret: string;
	algorithm: "SHA1";
	digits: number;
	period: number;
	lastUsedStep: number;
	failedAttempts: number;
	/** ISO timestamp string, or null when not locked */
	lockedUntil: string | null;
	verified: boolean;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Input shape for creating a new TOTP credential. The adapter fills in
 * createdAt / updatedAt / failedAttempts / lockedUntil / lastUsedStep
 * with their default values.
 */
export interface NewTOTPSecret {
	userId: string;
	encryptedSecret: string;
	algorithm?: "SHA1";
	digits?: number;
	period?: number;
	verified?: boolean;
}

/**
 * Partial update shape for the verify route's state-machine writes.
 *
 * Three fields are mutated during normal operation:
 * - lastUsedStep — bumped on every successful verification (replay guard)
 * - failedAttempts — incremented on each wrong code, reset to 0 on
 *   successful verification or recovery code use
 * - lockedUntil — set to a future timestamp when failedAttempts crosses
 *   the lockout threshold; cleared when the user successfully unlocks
 *   via recovery code
 *
 * The encrypted secret itself is intentionally NOT in this shape — once
 * persisted, the secret is immutable for the credential's lifetime.
 * Rotating a TOTP secret means deleteTOTP + createTOTP, not updateTOTP.
 */
export interface UpdateTOTPSecret {
	lastUsedStep?: number;
	failedAttempts?: number;
	/** ISO timestamp string, or null to clear the lockout */
	lockedUntil?: string | null;
	verified?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard period for RFC 6238 TOTP — 30 seconds. */
export const TOTP_PERIOD_SECONDS = 30;

/** Standard digit count — 6. */
export const TOTP_DIGITS = 6;

/**
 * Clock-drift tolerance window expressed in number of TOTP periods on
 * each side. We accept the current period plus the previous one — that's
 * a 30-60 second tolerance window for client clock drift. Going wider
 * (±2 periods = 90s) doubles the brute-force surface for negligible UX gain.
 */
export const TOTP_DRIFT_PERIODS = 1;

/**
 * Maximum number of consecutive failed TOTP login attempts before the
 * account is locked. The user must use a recovery code to unlock.
 */
export const LOCKOUT_THRESHOLD = 10;

/**
 * How long an account stays locked after hitting LOCKOUT_THRESHOLD,
 * in milliseconds. After this window, the user can attempt TOTP again
 * but a single failure re-locks them (failedAttempts is not reset until
 * a successful verification or recovery code use).
 */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Number of recovery codes to generate at TOTP setup. RFC has no opinion;
 * the industry pattern is 8-10. We pick 10 — buys ~5 lockouts before the
 * user is in real trouble.
 */
export const RECOVERY_CODE_COUNT = 10;

// ============================================================================
// Errors
// ============================================================================

/**
 * Discriminated error class for the TOTP module. Each call site can
 * `instanceof TOTPError` and switch on `code` to render the right
 * user-facing message and HTTP status.
 *
 * The message field is for logs and tests, NOT for user display — the
 * route layer maps `code` to a user-facing copy string (see the error
 * registry in PLAN.md Phase 3.5 Pass 3).
 */
export class TOTPError extends Error {
	constructor(
		public readonly code: TOTPErrorCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "TOTPError";
	}
}

export type TOTPErrorCode =
	/** Decryption of the stored secret failed (corruption or wrong auth secret). */
	| "decrypt_failed"
	/** Code is correctly formatted but doesn't match any candidate counter in the drift window. */
	| "invalid_code"
	/** Code is correctly formatted and would otherwise match, but its step is <= lastUsedStep (replay). */
	| "replay"
	/** failedAttempts >= LOCKOUT_THRESHOLD and lockedUntil is in the future. */
	| "locked"
	/** Setup state expired (auth_challenges row TTL elapsed before verify). */
	| "setup_expired"
	/** TOTP secret already exists for this user (race or programmer error). */
	| "already_configured";
