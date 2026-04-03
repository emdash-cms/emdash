/**
 * Synchronous crypto helpers — Node.js only.
 *
 * These functions use `node:crypto` directly and work in Node 15+. They are
 * intentionally kept synchronous for Node-only helpers and tests. Route-path
 * and webhook-path code must prefer the async runtime adapter in
 * `./lib/crypto-adapter.js` so Workers / edge runtimes stay portable.
 *
 * Legacy/compatibility guidance:
 * - New feature code should not import this file.
 * - Keep production request-path code on `crypto-adapter`.
 * - This module exists only as an internal Node-only fallback/legacy helper.
 *
 * For Workers / edge runtimes that lack `node:crypto`, use the async
 * equivalents exported from `./lib/crypto-adapter.js` instead:
 *   - `sha256HexAsync`
 *   - `equalSha256HexDigestAsync`
 *   - `randomHex`
 *   - `hmacSha256HexAsync`
 *   - `constantTimeEqualHexAsync`
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * @deprecated Node-only legacy sync helper. Prefer `sha256HexAsync` from
 * `./lib/crypto-adapter.js`.
 */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** @deprecated Node-only legacy sync helper. Prefer `randomHex` from `./lib/crypto-adapter.js`. */
/** Opaque server-issued finalize secret (store only `sha256Hex` on the order). */
export function randomFinalizeTokenHex(byteLength = 24): string {
	return randomBytes(byteLength).toString("hex");
}

/**
 * @deprecated Node-only legacy sync helper. Prefer `equalSha256HexDigestAsync`
 * from `./lib/crypto-adapter.js`.
 */
export function equalSha256HexDigest(a: string, b: string): boolean {
	if (a.length !== 64 || b.length !== 64) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}
