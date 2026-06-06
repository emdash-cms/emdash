/**
 * Session binding for the first-setup admin-creation flow.
 *
 * Shared constants for the nonce cookie that ties /_emdash/api/setup/admin
 * and /_emdash/api/setup/admin/verify to the same browser. Without this
 * binding, any unauthenticated caller could POST /setup/admin during the
 * setup window and substitute their own email into the stored setup state
 * before the legitimate admin completes passkey verification.
 *
 * Implementation lives in the two route handlers; this module is just
 * the name / lifetime so both ends agree.
 */

/** Cookie name carrying the setup-admin session nonce. */
export const SETUP_NONCE_COOKIE = "emdash_setup_nonce";

/**
 * Cookie max-age in seconds. One hour is plenty of time to complete
 * a passkey registration; if the user lingers longer the admin step
 * can simply be retried.
 */
export const SETUP_NONCE_MAX_AGE_SECONDS = 60 * 60;
