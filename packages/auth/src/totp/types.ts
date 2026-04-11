/** Types for the TOTP (RFC 6238) authentication module. */

/**
 * Persisted TOTP credential, one row per user. `encryptedSecret` is
 * the HKDF-encrypted base32 key. `lastUsedStep` is the RFC 6238
 * epoch counter of the most recent successful verification — used
 * for replay protection (reject any code whose candidate step is
 * `<= lastUsedStep`).
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

export interface NewTOTPSecret {
	userId: string;
	encryptedSecret: string;
	algorithm?: "SHA1";
	digits?: number;
	period?: number;
	verified?: boolean;
}

/**
 * Partial update for the state-machine columns. The encrypted secret
 * itself is immutable — rotating means deleteTOTP + createTOTP.
 */
export interface UpdateTOTPSecret {
	lastUsedStep?: number;
	failedAttempts?: number;
	/** ISO timestamp string, or null to clear the lockout */
	lockedUntil?: string | null;
	verified?: boolean;
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Drift tolerance on each side of current step. 1 = ±30s window. */
export const TOTP_DRIFT_PERIODS = 1;

/** Consecutive wrong codes before lockout (recovery code required to clear). */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export const RECOVERY_CODE_COUNT = 10;

/** Discriminated error for the TOTP module. */
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
	| "decrypt_failed"
	| "invalid_code"
	| "replay"
	| "locked"
	| "setup_expired"
	| "already_configured";
