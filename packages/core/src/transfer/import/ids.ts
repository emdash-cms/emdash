/**
 * Deterministic ids and opaque values derived from an import operation, so a
 * replayed batch writes exactly what the interrupted attempt wrote.
 */

import { sha256Hex } from "../format/digest.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID-shaped id (26 Crockford base32 characters) derived from the SHA-256
 * of `parts`. Stable for the same inputs; the leading character is always in
 * `0`–`7`, as in a real ULID.
 */
export async function ulidFromHash(...parts: string[]): Promise<string> {
	const hex = await sha256Hex(parts.join("\u0000"));
	let bits = BigInt(`0x${hex.slice(0, 32)}`);
	let id = "";
	for (let index = 0; index < 26; index++) {
		id = CROCKFORD[Number(bits & 31n)] + id;
		bits >>= 5n;
	}
	return id;
}

/** Hex HMAC-SHA-256 of `message` under `secret`. */
export async function hmacHex(secret: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
	return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
