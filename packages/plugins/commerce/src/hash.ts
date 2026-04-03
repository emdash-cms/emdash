/**
 * Synchronous crypto helpers — Node.js only.
 *
 * These functions use `node:crypto` directly and work in Node 15+. They are
 * intentionally kept synchronous for Node-only helpers and tests. Route-path
 * and webhook-path code must prefer the async runtime adapter in
 * `./lib/crypto-adapter.js` so Workers / edge runtimes stay portable.
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

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Opaque server-issued finalize secret (store only `sha256Hex` on the order). */
export function randomFinalizeTokenHex(byteLength = 24): string {
	return randomBytes(byteLength).toString("hex");
}

/** Constant-time compare for two 64-char hex SHA-256 digests. */
export function equalSha256HexDigest(a: string, b: string): boolean {
	if (a.length !== 64 || b.length !== 64) return false;
	try {
		return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
	} catch {
		return false;
	}
}
