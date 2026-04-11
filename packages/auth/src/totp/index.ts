/**
 * TOTP (RFC 6238) authentication module — authenticator-app login as an
 * alternative to passkeys.
 *
 * Discussion: https://github.com/emdash-cms/emdash/discussions/432
 */

export type { TOTPSecret, NewTOTPSecret, UpdateTOTPSecret, TOTPErrorCode } from "./types.js";
export {
	TOTPError,
	TOTP_PERIOD_SECONDS,
	TOTP_DIGITS,
	TOTP_DRIFT_PERIODS,
	LOCKOUT_THRESHOLD,
	LOCKOUT_DURATION_MS,
	RECOVERY_CODE_COUNT,
} from "./types.js";

export type { GeneratedTOTPSecret, OtpAuthURIOptions } from "./setup.js";
export { generateTOTPSecret, buildOtpAuthURI } from "./setup.js";

export type { VerifyTOTPOptions, VerifyTOTPResult } from "./verify.js";
export { verifyTOTPCode } from "./verify.js";

export { generateRecoveryCode, generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes.js";
