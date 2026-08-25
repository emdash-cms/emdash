/**
 * API token generation and hashing utilities.
 *
 * Re-exports from @emdash-cms/auth which owns the implementations.
 * Uses Oslo.js (@oslojs/crypto, @oslojs/encoding) for all crypto.
 *
 * Token format: `ec_pat_<base64url>` (Personal Access Tokens)
 *               `ec_oat_<base64url>` (OAuth Access Tokens)
 *               `ec_ort_<base64url>` (OAuth Refresh Tokens)
 *
 * Prefix makes tokens identifiable in logs and secret scanners.
 * Only the SHA-256 hash is stored server-side.
 */

export {
	TOKEN_PREFIXES,
	generatePrefixedToken,
	hashPrefixedToken,
	hashPrefixedToken as hashApiToken,
	VALID_SCOPES,
	validateScopes,
	isValidScope,
	hasScope,
	computeS256Challenge,
	type ApiTokenScope,
} from "@emdash-cms/auth";
