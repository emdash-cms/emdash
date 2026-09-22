/**
 * Base64 encoding/decoding utilities.
 *
 * Uses native Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 when
 * available (workerd, Node 26+, modern browsers), falls back to btoa/atob.
 *
 * All base64url encoding uses the { alphabet: "base64url" } option natively
 * or manual character replacement as fallback.
 *
 * Delete the fallback paths when the minimum Node version supports these
 * methods natively.
 */

const hasNative =
	typeof Uint8Array.prototype.toBase64 === "function" &&
	typeof Uint8Array.fromBase64 === "function";

// Regex patterns for base64url character replacement
const BASE64_PLUS_PATTERN = /\+/g;
const BASE64_SLASH_PATTERN = /\//g;
const BASE64_PADDING_PATTERN = /=+$/;
const BASE64URL_DASH_PATTERN = /-/g;
const BASE64URL_UNDERSCORE_PATTERN = /_/g;

// ---------------------------------------------------------------------------
// Standard base64 (for opaque tokens, cursors, Basic Auth, etc.)
// ---------------------------------------------------------------------------

/** Encode a UTF-8 string as standard base64. */
export function encodeBase64(str: string): string {
	const bytes = new TextEncoder().encode(str);
	if (hasNative) return bytes.toBase64();
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** Decode a standard base64 string to a UTF-8 string. */
export function decodeBase64(base64: string): string {
	return new TextDecoder().decode(decodeBase64Bytes(base64));
}

/** Decode a standard base64 string to raw bytes (for binary payloads). */
export function decodeBase64Bytes(base64: string): Uint8Array {
	if (hasNative) return Uint8Array.fromBase64(base64);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---------------------------------------------------------------------------
// Base64url (for tokens, HMAC signatures, PKCE, etc.)
// ---------------------------------------------------------------------------

/** Encode bytes as base64url without padding. */
export function encodeBase64url(bytes: Uint8Array): string {
	if (hasNative) return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(BASE64_PLUS_PATTERN, "-")
		.replace(BASE64_SLASH_PATTERN, "_")
		.replace(BASE64_PADDING_PATTERN, "");
}

/** Decode a base64url string (with or without padding) to bytes. */
export function decodeBase64url(encoded: string): Uint8Array {
	if (hasNative) return Uint8Array.fromBase64(encoded, { alphabet: "base64url" });
	const base64 = encoded
		.replace(BASE64URL_DASH_PATTERN, "+")
		.replace(BASE64URL_UNDERSCORE_PATTERN, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
