/**
 * Secure token utilities
 *
 * Crypto via Oslo.js (@oslojs/crypto). Base64url via @oslojs/encoding.
 *
 * Tokens are opaque random values. We store only the SHA-256 hash in the database.
 */

import { hmac } from "@oslojs/crypto/hmac";
import { sha256, SHA256 } from "@oslojs/crypto/sha2";
import { constantTimeEqual } from "@oslojs/crypto/subtle";
import { encodeBase64urlNoPadding, decodeBase64urlIgnorePadding } from "@oslojs/encoding";

const TOKEN_BYTES = 32; // 256 bits of entropy

// ---------------------------------------------------------------------------
// API Token Prefixes
// ---------------------------------------------------------------------------

/** Valid API token prefixes */
export const TOKEN_PREFIXES = {
	PAT: "ec_pat_",
	OAUTH_ACCESS: "ec_oat_",
	OAUTH_REFRESH: "ec_ort_",
} as const;

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** All valid API token scopes */
export const VALID_SCOPES = [
	"content:read",
	"content:write",
	"media:read",
	"media:write",
	"schema:read",
	"schema:write",
	"admin",
] as const;

export type ApiTokenScope = (typeof VALID_SCOPES)[number];

/**
 * Validate that scopes are all valid.
 * Returns the invalid scopes, or empty array if all valid.
 */
export function validateScopes(scopes: string[]): string[] {
	const validSet = new Set<string>(VALID_SCOPES);
	return scopes.filter((s) => !validSet.has(s));
}

/**
 * Check if a set of scopes includes a required scope.
 * The `admin` scope grants access to everything.
 */
export function hasScope(scopes: string[], required: string): boolean {
	if (scopes.includes("admin")) return true;
	return scopes.includes(required);
}

/**
 * Generate a cryptographically secure random token
 * Returns base64url-encoded string (URL-safe)
 */
export function generateToken(): string {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return encodeBase64urlNoPadding(bytes);
}

/**
 * Hash a token for storage
 * We never store raw tokens - only their SHA-256 hash
 */
export function hashToken(token: string): string {
	const bytes = decodeBase64urlIgnorePadding(token);
	const hash = sha256(bytes);
	return encodeBase64urlNoPadding(hash);
}

/**
 * Generate a token and its hash together
 */
export function generateTokenWithHash(): { token: string; hash: string } {
	const token = generateToken();
	const hash = hashToken(token);
	return { token, hash };
}

/**
 * Generate a session ID (shorter, for cookie storage)
 */
export function generateSessionId(): string {
	const bytes = new Uint8Array(20); // 160 bits
	crypto.getRandomValues(bytes);
	return encodeBase64urlNoPadding(bytes);
}

/**
 * Generate an auth secret for configuration
 */
export function generateAuthSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return encodeBase64urlNoPadding(bytes);
}

// ---------------------------------------------------------------------------
// Prefixed API tokens (ec_pat_, ec_oat_, ec_ort_)
// ---------------------------------------------------------------------------

/**
 * Generate a prefixed API token and its hash.
 * Returns the raw token (shown once to the user), the hash (stored server-side),
 * and a display prefix (for identification in UIs/logs).
 *
 * Uses oslo/crypto for SHA-256 hashing.
 */
export function generatePrefixedToken(prefix: string): {
	raw: string;
	hash: string;
	prefix: string;
} {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);

	const encoded = encodeBase64urlNoPadding(bytes);
	const raw = `${prefix}${encoded}`;
	const hash = hashPrefixedToken(raw);

	// First few chars for identification in UIs
	const displayPrefix = raw.slice(0, prefix.length + 4);

	return { raw, hash, prefix: displayPrefix };
}

/**
 * Hash a prefixed API token for storage/lookup.
 * Hashes the full prefixed token string via SHA-256, returns base64url (no padding).
 */
export function hashPrefixedToken(token: string): string {
	const bytes = new TextEncoder().encode(token);
	const hash = sha256(bytes);
	return encodeBase64urlNoPadding(hash);
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — server-side verification
// ---------------------------------------------------------------------------

/**
 * Compute an S256 PKCE code challenge from a code verifier.
 * Used server-side to verify that code_verifier matches the stored code_challenge.
 *
 * Equivalent to: BASE64URL(SHA256(ASCII(code_verifier)))
 */
export function computeS256Challenge(codeVerifier: string): string {
	const hash = sha256(new TextEncoder().encode(codeVerifier));
	return encodeBase64urlNoPadding(hash);
}

/**
 * Constant-time comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
	const text = new TextEncoder();
	const salt = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
	const hash = (str: string) => hmac(SHA256, salt, text.encode(str));

	return constantTimeEqual(hash(a), hash(b));
}

// ============================================================================
// Encryption utilities (for storing OAuth secrets)
// ============================================================================

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12;

/**
 * Derive an encryption key from the auth secret
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
	const decoded = decodeBase64urlIgnorePadding(secret);
	// Create a new ArrayBuffer to ensure compatibility with crypto.subtle
	const buffer = new Uint8Array(decoded).buffer;
	const keyMaterial = await crypto.subtle.importKey("raw", buffer, "PBKDF2", false, ["deriveKey"]);

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: new TextEncoder().encode("emdash-auth-v1"),
			iterations: 100000,
			hash: "SHA-256",
		},
		keyMaterial,
		{ name: ALGORITHM, length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Encrypt a value using AES-GCM
 */
export async function encrypt(plaintext: string, secret: string): Promise<string> {
	const key = await deriveKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const encoded = new TextEncoder().encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

	// Prepend IV to ciphertext
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return encodeBase64urlNoPadding(combined);
}

/**
 * Decrypt a value encrypted with encrypt()
 */
export async function decrypt(encrypted: string, secret: string): Promise<string> {
	const key = await deriveKey(secret);
	const combined = decodeBase64urlIgnorePadding(encrypted);

	const iv = combined.slice(0, IV_BYTES);
	const ciphertext = combined.slice(IV_BYTES);

	const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);

	return new TextDecoder().decode(decrypted);
}

// ============================================================================
// HKDF-based encryption (for storing high-entropy secrets like TOTP keys)
// ============================================================================
//
// PBKDF2 (the encrypt/decrypt path above) is the right primitive for
// password-derived secrets — it deliberately costs ~50-100ms per call to
// resist offline brute force. That cost is fine for OAuth client secrets
// (decrypted rarely) but wrong for TOTP secrets, which are decrypted on
// every login attempt and are already 160 bits of cryptographic randomness.
//
// HKDF (RFC 5869) is the correct KDF for already-random key material:
// it's near-instant (microseconds), deterministic, and doesn't need a
// process-local cache to be fast. We use it for the TOTP encryption path.
//
// Both paths target the same AES-GCM-256 cipher and the same on-disk format
// (IV || ciphertext, base64url-encoded). The two paths are NOT interchangeable
// at decrypt time — a value encrypted with PBKDF2 cannot be decrypted with
// HKDF or vice versa, because the derived keys differ.

const HKDF_SALT = new TextEncoder().encode("emdash-totp-encryption-v1");
const HKDF_INFO = new TextEncoder().encode("emdash-totp-secret-encryption");

/**
 * Derive an AES-GCM key from a high-entropy auth secret via HKDF-SHA256.
 *
 * Use this for encrypting already-random key material (TOTP secrets, etc.).
 * For password-derived secrets, use the PBKDF2 path via encrypt()/decrypt().
 */
async function deriveKeyHKDF(secret: string): Promise<CryptoKey> {
	const decoded = decodeBase64urlIgnorePadding(secret);
	const buffer = new Uint8Array(decoded).buffer;
	const baseKey = await crypto.subtle.importKey("raw", buffer, "HKDF", false, ["deriveKey"]);

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: HKDF_SALT,
			info: HKDF_INFO,
		},
		baseKey,
		{ name: ALGORITHM, length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/**
 * Encrypt a value using AES-GCM with an HKDF-derived key.
 *
 * Wire-format compatible with decryptWithHKDF only — values encrypted here
 * CANNOT be decrypted by decrypt() (and vice versa) because the key
 * derivation paths differ.
 */
export async function encryptWithHKDF(plaintext: string, secret: string): Promise<string> {
	const key = await deriveKeyHKDF(secret);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const encoded = new TextEncoder().encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, encoded);

	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return encodeBase64urlNoPadding(combined);
}

/**
 * Decrypt a value encrypted with encryptWithHKDF().
 */
export async function decryptWithHKDF(encrypted: string, secret: string): Promise<string> {
	const key = await deriveKeyHKDF(secret);
	const combined = decodeBase64urlIgnorePadding(encrypted);

	const iv = combined.slice(0, IV_BYTES);
	const ciphertext = combined.slice(IV_BYTES);

	const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);

	return new TextDecoder().decode(decrypted);
}
