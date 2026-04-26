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
	"taxonomies:manage",
	"menus:manage",
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
 * Scope grants — when a token holds the key scope, it implicitly grants
 * the listed scopes too. This keeps existing tokens working when more
 * granular scopes are introduced.
 *
 * Specifically, `content:write` was historically the only scope we checked
 * for menu and taxonomy mutations. After splitting those out into
 * `menus:manage` and `taxonomies:manage`, existing PATs with `content:write`
 * continue to work via this grant table.
 *
 * Lookup is one-hop — chaining (`A → B → C`) is NOT supported. If a chain
 * is needed, expand the values explicitly. Backed by a `Map` rather than a
 * plain object so prototype-chain keys (`__proto__`, `constructor`, etc.)
 * can't smuggle non-array values through bracket access.
 */
const IMPLICIT_SCOPE_GRANTS = new Map<string, readonly string[]>([
	["content:write", ["menus:manage", "taxonomies:manage"]],
]);

/**
 * Check if a set of scopes includes a required scope.
 *
 * The `admin` scope grants access to everything. `content:write` implicitly
 * grants `menus:manage` and `taxonomies:manage` to preserve backwards
 * compatibility with PATs issued before those scopes were split out.
 */
export function hasScope(scopes: string[], required: string): boolean {
	if (scopes.includes("admin")) return true;
	if (scopes.includes(required)) return true;
	for (const held of scopes) {
		const granted = IMPLICIT_SCOPE_GRANTS.get(held);
		if (granted?.includes(required)) return true;
	}
	return false;
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
